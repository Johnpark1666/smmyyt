// API client — pure Tauri IPC, no HTTP, no ports
import { invoke } from '@tauri-apps/api/core';

export interface ApiResponse<T = any> {
  data: T;
  status: number;
}

interface CallConfig {
  params?: Record<string, string | number | boolean>;
}

async function call<T = any>(
  method: string,
  path: string,
  body: unknown,
  config?: CallConfig
): Promise<ApiResponse<T>> {
  const q = config?.params || {};
  const res = await invoke('api_call', {
    method,
    path,
    body: body ? JSON.stringify(body) : '',
    query: JSON.stringify(q),
  });
  // Tauri IPC는 String을 그대로 전달하므로 JSON 파싱 필요
  const data = typeof res === 'string' ? JSON.parse(res) : res;
  return { data, status: 200 };
}

export default {
  get: <T = any>(path: string, config?: CallConfig) => call<T>('GET', path, null, config),
  post: <T = any>(path: string, body?: unknown, config?: CallConfig) => call<T>('POST', path, body, config),
  put: <T = any>(path: string, body?: unknown, config?: CallConfig) => call<T>('PUT', path, body, config),
  patch: <T = any>(path: string, body?: unknown, config?: CallConfig) => call<T>('PATCH', path, body, config),
  delete: <T = any>(path: string, config?: CallConfig) => call<T>('DELETE', path, null, config),
};