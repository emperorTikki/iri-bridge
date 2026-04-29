# IRI Listings Bridge

WordPress plugin that connects Bricks Builder to a Cloudflare D1 database via a Worker API.

## Setup

1. Upload the `iri-bridge` folder to `wp-content/plugins/`
2. Fill in the constants at the top of `iri-bridge.php`:
   - `IRI_WORKER_URL` — your Cloudflare Worker URL
   - `IRI_CF_ACCOUNT_HASH` — your Cloudflare Images account hash
   - `IRI_MAPS_KEY` — your Google Maps JavaScript API key (browser key, restricted to your domain)
3. Activate the plugin in WordPress → Plugins
4. Paste `iri-archive.js` into your Bricks archive template → Code element → Footer
5. Add `iri-archive.css` to your Bricks template CSS editor

## Auto-updates

This plugin supports automatic updates via [Git Updater](https://git-updater.com/).
Install Git Updater on your WordPress site and updates will appear in Dashboard → Plugins.
