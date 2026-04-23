import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.tsx";
const app = new Hono();

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// ── LiveKit JWT helpers ────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function jsonB64(obj: object): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signLiveKitToken(
  apiKey: string,
  apiSecret: string,
  roomName: string,
  participantIdentity: string,
  participantName: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header  = jsonB64({ alg: 'HS256', typ: 'JWT' });
  const payload = jsonB64({
    iss: apiKey,
    sub: participantIdentity,
    iat: now,
    exp: now + 3600,
    jti: `${participantIdentity}-${now}`,
    name: participantName,
    video: {
      room: roomName,
      roomJoin: true,
      roomCreate: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  });

  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
// ──────────────────────────────────────────────────────────────────────────

// Health check endpoint
app.get("/make-server-b5560c10/health", (c) => {
  return c.json({ status: "ok" });
});

// ── LiveKit token endpoint ────────────────────────────────────────────────
app.post("/make-server-b5560c10/livekit-token", async (c) => {
  try {
    const apiKey    = Deno.env.get("LIVEKIT_API_KEY");
    const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    const livekitUrl = Deno.env.get("LIVEKIT_URL") ?? "wss://meet.planaro.ru";

    if (!apiKey || !apiSecret) {
      return c.json({ error: "LiveKit not configured (missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET)" }, 500);
    }

    const { roomId, participantId, participantName } = await c.req.json();
    if (!roomId || !participantId || !participantName) {
      return c.json({ error: "Missing roomId, participantId or participantName" }, 400);
    }

    const token = await signLiveKitToken(apiKey, apiSecret, roomId, participantId, participantName);
    return c.json({ token, url: livekitUrl });
  } catch (error) {
    console.log("LiveKit token error:", error);
    return c.json({ error: `Failed to generate token: ${error.message}` }, 500);
  }
});

// Join room - add participant to room
app.post("/make-server-b5560c10/room/:roomId/join", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const body = await c.req.json();
    const { participantId, participantName } = body;

    if (!participantId || !participantName) {
      return c.json({ error: "Missing participantId or participantName" }, 400);
    }

    // Get current room participants
    const roomKey = `room:${roomId}:participants`;
    let participants = await kv.get(roomKey) || [];

    // Add new participant if not already in room
    const existingIndex = participants.findIndex((p: any) => p.id === participantId);

    // Clean up stale participants (no heartbeat in last 90 seconds)
    const now = Date.now();
    participants = participants.filter((p: any) => {
      if (p.id === participantId) return true; // Keep self (will upsert below)
      const lastSeen = p.lastHeartbeat ?? new Date(p.joinedAt ?? 0).getTime();
      return (now - lastSeen) < 90000;
    });

    const freshIndex = participants.findIndex((p: any) => p.id === participantId);
    if (freshIndex === -1) {
      participants.push({
        id: participantId,
        name: participantName,
        joinedAt: new Date().toISOString(),
        lastHeartbeat: now,
      });
    } else {
      participants[freshIndex].name = participantName;
      participants[freshIndex].lastHeartbeat = now;
    }
    await kv.set(roomKey, participants);

    return c.json({ participants });
  } catch (error) {
    console.log("Error joining room:", error);
    return c.json({ error: `Failed to join room: ${error.message}` }, 500);
  }
});

// Leave room - remove participant from room
app.post("/make-server-b5560c10/room/:roomId/leave", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const body = await c.req.json();
    const { participantId } = body;

    if (!participantId) {
      return c.json({ error: "Missing participantId" }, 400);
    }

    const roomKey = `room:${roomId}:participants`;
    let participants = await kv.get(roomKey) || [];

    // Remove participant
    participants = participants.filter((p: any) => p.id !== participantId);
    await kv.set(roomKey, participants);

    return c.json({ participants });
  } catch (error) {
    console.log("Error leaving room:", error);
    return c.json({ error: `Failed to leave room: ${error.message}` }, 500);
  }
});

// Heartbeat — keeps participant entry alive in the room
app.post("/make-server-b5560c10/room/:roomId/heartbeat", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const { participantId } = await c.req.json();
    if (!participantId) return c.json({ error: "Missing participantId" }, 400);

    const roomKey = `room:${roomId}:participants`;
    const participants = await kv.get(roomKey) || [];
    const idx = participants.findIndex((p: any) => p.id === participantId);
    if (idx !== -1) {
      participants[idx].lastHeartbeat = Date.now();
      await kv.set(roomKey, participants);
    }
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: `Failed heartbeat: ${error.message}` }, 500);
  }
});

// Get room participants
app.get("/make-server-b5560c10/room/:roomId/participants", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const roomKey = `room:${roomId}:participants`;
    let participants = await kv.get(roomKey) || [];

    // Filter out stale participants (no heartbeat in last 45 seconds)
    const now = Date.now();
    participants = participants.filter((p: any) => {
      const lastSeen = p.lastHeartbeat ?? new Date(p.joinedAt ?? 0).getTime();
      return (now - lastSeen) < 45000;
    });

    return c.json({ participants });
  } catch (error) {
    console.log("Error getting participants:", error);
    return c.json({ error: `Failed to get participants: ${error.message}` }, 500);
  }
});

// Store signaling data (SDP offer/answer, ICE candidates)
app.post("/make-server-b5560c10/room/:roomId/signal", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const body = await c.req.json();
    const { fromId, toId, type, data } = body;

    if (!fromId || !toId || !type || !data) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Store signal for recipient to retrieve
    const signalKey = `room:${roomId}:signal:${toId}:${Date.now()}`;
    await kv.set(signalKey, {
      fromId,
      toId,
      type,
      data,
      timestamp: new Date().toISOString(),
    });

    return c.json({ success: true });
  } catch (error) {
    console.log("Error storing signal:", error);
    return c.json({ error: `Failed to store signal: ${error.message}` }, 500);
  }
});

// Get pending signals for a participant
app.get("/make-server-b5560c10/room/:roomId/signals/:participantId", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const participantId = c.req.param("participantId");

    // Get all signals for this participant
    const prefix = `room:${roomId}:signal:${participantId}:`;
    const signals = await kv.getByPrefix(prefix);

    return c.json({ signals });
  } catch (error) {
    console.log("Error getting signals:", error);
    return c.json({ error: `Failed to get signals: ${error.message}` }, 500);
  }
});

// Clear signals after retrieval
app.delete("/make-server-b5560c10/room/:roomId/signals/:participantId", async (c) => {
  try {
    const roomId = c.req.param("roomId");
    const participantId = c.req.param("participantId");

    // Delete all signals for this participant
    const prefix = `room:${roomId}:signal:${participantId}:`;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    );
    const { data } = await supabase
      .from("kv_store_b5560c10")
      .select("key")
      .like("key", prefix + "%");

    if (data && data.length > 0) {
      const keys = data.map((d: any) => d.key);
      await kv.mdel(keys);
    }

    return c.json({ success: true });
  } catch (error) {
    console.log("Error clearing signals:", error);
    return c.json({ error: `Failed to clear signals: ${error.message}` }, 500);
  }
});

Deno.serve(app.fetch);