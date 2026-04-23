#!/bin/bash
# ============================================================
#  Добавить LiveKit secrets в Supabase
#  Запускать ПОСЛЕ setup-livekit.sh — вставь реальные значения!
#
#  Предварительно: supabase login
# ============================================================

# ⚠️  Заполни эти переменные значениями из setup-livekit.sh
LIVEKIT_API_KEY="APIplanaro_ЗАМЕНИ_НА_СВОЁ"
LIVEKIT_API_SECRET="ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ"
LIVEKIT_URL="wss://meet.planaro.ru"

echo "Добавляем secrets в Supabase..."
supabase secrets set \
  LIVEKIT_API_KEY="${LIVEKIT_API_KEY}" \
  LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET}" \
  LIVEKIT_URL="${LIVEKIT_URL}"

echo "✅ Secrets добавлены! Деплоим функцию..."
supabase functions deploy make-server-b5560c10

echo "Готово!"
