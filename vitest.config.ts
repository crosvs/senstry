import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		globals: true,
		setupFiles: ['src/vitest-setup.ts'],
		include: ['src/**/*.test.ts'],
	},
	resolve: {
		alias: {
			'$lib': path.resolve('./src/lib'),
		}
	}
});
