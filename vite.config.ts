import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.BASE_PATH ?? '';

export default defineConfig({
	base,
	plugins: [
		tailwindcss(),
		sveltekit(),
		VitePWA({
			registerType: 'prompt',
			injectRegister: 'auto',
			strategies: 'generateSW',
			workbox: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
				runtimeCaching: []
			},
			manifest: {
				name: 'Senstry',
				short_name: 'Senstry',
				description: 'Decentralized home security monitor via Nostr + WebRTC',
				start_url: base + '/',
				display: 'standalone',
				background_color: '#0f172a',
				theme_color: '#6366f1',
				orientation: 'any',
				categories: ['security', 'utilities'],
				icons: [
					{ src: base + '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: base + '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: base + '/icons/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				],
				shortcuts: [
					{
						name: 'Live View',
						url: base + '/viewer',
						icons: [{ src: base + '/icons/shortcut-viewer.png', sizes: '96x96' }]
					},
					{
						name: 'Monitor',
						url: base + '/monitor',
						icons: [{ src: base + '/icons/shortcut-monitor.png', sizes: '96x96' }]
					}
				]
			}
		})
	]
});
