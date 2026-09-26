import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Reload config with environment variables
export default defineConfig({ plugins: [react()] });
