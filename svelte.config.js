import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		paths: {
			base: process.env.CUSTOM_DOMAIN ? '' : process.env.NODE_ENV === 'production' ? '/nextui-web-dashboard' : ''
		},
		alias: {
			$components: 'src/components'
		}
	}
};

export default config;
