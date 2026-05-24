# IRI Listings Bridge

WordPress plugin that connects Bricks Builder to a Cloudflare D1 database via a Worker API.

## Setup

1. Upload the `iri-bridge` folder to `wp-content/plugins/`
2. Fill in the constants at the top of `iri-bridge.php`:
   - `IRI_WORKER_URL` — your Cloudflare Worker URL
   - `IRI_CF_ACCOUNT_HASH` — your Cloudflare Images account hash
   - `IRI_MAPS_KEY` — your Google Maps JavaScript API key (browser key, restricted to your domain)
3. Activate the plugin in WordPress → Plugins

### Archive page

The archive JS and CSS are served directly from the Cloudflare Worker — no manual file installation needed. The plugin enqueues them automatically from `IRI_WORKER_URL`.

### Distances accordion

Add the `[iri_distances]` shortcode inside your Bricks distances accordion section. It renders airport, nearest station, and top-5 ski resort drive times, loading asynchronously after page render.

## Auto-updates

This plugin supports automatic updates via [Git Updater](https://git-updater.com/).
Install Git Updater on your WordPress site and updates will appear in Dashboard → Plugins.
