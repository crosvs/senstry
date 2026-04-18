import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
				start_url: '/',
				display: 'standalone',
				background_color: '#0f172a',
				theme_color: '#6366f1',
				orientation: 'any',
				categories: ['security', 'utilities'],
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: '/icons/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				],
				shortcuts: [
					{
						name: 'Live View',
						url: '/viewer',
						icons: [{ src: '/icons/shortcut-viewer.png', sizes: '96x96' }]
					},
					{
						name: 'Monitor',
						url: '/monitor',
						icons: [{ src: '/icons/shortcut-monitor.png', sizes: '96x96' }]
					}
				]
			}
		})
	]
});
