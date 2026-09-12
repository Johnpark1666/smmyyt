/**
 * 클라이언트 Feature Flag
 *
 * VITE_ 환경변수로 제어되며, runtime 설정 변경은 불가능.
 * 배포 시 .env.production에서 VITE_FEATURE_GITHUB / VITE_FEATURE_NOTEBOOKLM 설정.
 *
 * 설정 파일이므로 Settings UI에서 ON/OFF를 변경하는 것은
 * 서버 재시작이 필요함을 안내하는 UI 전용.
 */

interface Features {
  github: boolean;
  notebooklm: boolean;
}

const features: Features = {
  github: import.meta.env.VITE_FEATURE_GITHUB === 'true',
  notebooklm: import.meta.env.VITE_FEATURE_NOTEBOOKLM === 'true',
};

export const FEATURES = features;

/** feature가 활성화되었는지 확인 */
export const isEnabled = (name: keyof Features): boolean => features[name] === true;