import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 앱(/ilgampack)과 별도 포트로 동시 구동 가능하도록 5174 사용
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
  },
  preview: {
    port: 4174,
  },
});
