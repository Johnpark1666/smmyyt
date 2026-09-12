/// <reference types="vite/client" />
declare module '*.css';

declare global {
  interface Window {
    __summDirty?: boolean;
  }
}

import * as React from 'react';
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | string;
    [key: `--${string}`]: string | number | undefined;
  }
}
