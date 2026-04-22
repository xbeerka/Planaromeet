import { ReactNode } from 'react';

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="size-full bg-[#202124]">
      {children}
    </div>
  );
}
