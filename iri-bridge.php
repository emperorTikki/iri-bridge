<?php
/**
 * Plugin Name: IRI Listings Bridge
 * Description: Connects Bricks Builder to the IRI Cloudflare D1 database via Worker API.
 *              Handles URL routing for /listings/{region}/{municipality}/{slug}/
 *              and registers dynamic data tags for all listing fields.
 * Version: 1.6.0
 * GitHub Plugin URI: emperorTikki/iri-bridge
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ── Configuration ─────────────────────────────────────────────────────────────
define( 'IRI_WORKER_URL',      'https://asahirealestatelistings.frosty-poetry-ee8c.workers.dev' );
define( 'IRI_CACHE_TTL',       300 );                    // seconds to cache API responses (5 min)
define( 'IRI_CF_ACCOUNT_HASH', 'yYahxCzaa87zUnivVan2mg' ); // Cloudflare Images account hash
define( 'IRI_MAPS_KEY',        'YOUR_GOOGLE_MAPS_KEY' );  // Google Maps JavaScript API key (browser key, restricted to your domain)

// ── 0. Archive config — always output in <head> so footer JS can read it ──────
// Must be a top-level hook. Adding it inside a shortcode callback is too late —
// wp_head fires before shortcodes are processed during content rendering.
add_action( 'wp_head', function() {
    echo '<script>window.IRI_ARCHIVE_CONFIG = ' . wp_json_encode( [
        'workerUrl' => IRI_WORKER_URL,
        'cfHash'    => IRI_CF_ACCOUNT_HASH,
        'limit'     => 500,
    ] ) . ';</script>' . "\n";
}, 1 );

// ── 1. Rewrite rules ──────────────────────────────────────────────────────────

add_action( 'init', 'iri_add_rewrite_rules' );
function iri_add_rewrite_rules() {
    // /listing/kamikawa/asahikawa/existing-house-asahikawa-364528/
    // Points WordPress at the shell post (so Bricks sees "Post Type: listing" immediately)
    // while also passing the IRI query vars for data fetching.
    add_rewrite_rule(
        '^listing/([^/]+)/([^/]+)/([^/]+)/?$',
        'index.php?listing=iri-shell&iri_region=$matches[1]&iri_area=$matches[2]&iri_slug=$matches[3]',
        'top'
    );
}

add_filter( 'query_vars', 'iri_register_query_vars' );
function iri_register_query_vars( $vars ) {
    $vars[] = 'iri_region';
    $vars[] = 'iri_area';
    $vars[] = 'iri_slug';
    return $vars;
}

// On activation: flush rewrites + create the shell post
register_activation_hook( __FILE__, function() {
    iri_add_rewrite_rules();
    iri_ensure_shell_post();
    flush_rewrite_rules();
} );
register_deactivation_hook( __FILE__, 'flush_rewrite_rules' );

// Create (or find) the hidden shell listing post used to satisfy Bricks conditions
function iri_ensure_shell_post() {
    $existing = get_option( 'iri_shell_post_id' );
    if ( $existing && get_post( $existing ) ) return $existing;

    $id = wp_insert_post( [
        'post_type'   => 'listing',
        'post_status' => 'publish',
        'post_title'  => '__iri_shell__',
        'post_name'   => 'iri-shell',
    ] );

    if ( ! is_wp_error( $id ) ) {
        update_option( 'iri_shell_post_id', $id );
    }
    return $id;
}

function iri_get_shell_post_id() {
    return (int) get_option( 'iri_shell_post_id', 0 );
}

// ── 2. Template routing ───────────────────────────────────────────────────────

// Exclude the shell post from all public archives, sitemaps, and loops.
add_action( 'pre_get_posts', 'iri_exclude_shell_from_queries' );
function iri_exclude_shell_from_queries( $query ) {
    $shell_id = iri_get_shell_post_id();
    if ( ! $shell_id ) return;

    // Only act on the main query on the front-end; leave admin / REST alone.
    if ( is_admin() || ! $query->is_main_query() ) return;

    // If this is the shell post being loaded via our rewrite rule, leave it alone.
    if ( get_query_var( 'iri_slug' ) ) return;

    // Everywhere else: exclude the shell post.
    $excluded   = (array) $query->get( 'post__not_in' );
    $excluded[] = $shell_id;
    $query->set( 'post__not_in', array_unique( $excluded ) );
}

// ── 2a. Schema.org JSON-LD for single listing pages ──────────────────────────
// Outputs a <script type="application/ld+json"> block in <head> for every
// single listing page. Google prefers JSON-LD over inline microdata.
// Works alongside any itemprop/itemscope attributes you add in Bricks.

add_action( 'wp_head', 'iri_output_schema_jsonld' );
function iri_output_schema_jsonld() {
    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return;

    $l = $iri_current_listing;

    // Map property type to the most specific Schema.org type
    $prop_type = strtolower( $l['property_type_en'] ?? '' );
    if ( str_contains( $prop_type, 'land' ) ) {
        $schema_type = 'LandOrCottage';
    } elseif ( str_contains( $prop_type, 'house' ) ) {
        $schema_type = 'SingleFamilyResidence';
    } elseif ( str_contains( $prop_type, 'condo' ) || str_contains( $prop_type, 'apartment' ) ) {
        $schema_type = 'Apartment';
    } elseif ( str_contains( $prop_type, 'building' ) ) {
        $schema_type = 'Accommodation';
    } else {
        $schema_type = 'RealEstateListing';
    }

    $region  = $l['region'] ?? 'hokkaido';
    $area    = $l['taxonomy_property_area'] ?? '';
    $slug    = $l['slug'] ?? '';
    $url     = home_url( "/listing/{$region}/{$area}/{$slug}/" );

    // First image (prefer Cloudflare full variant)
    $cf_ids    = array_filter( explode( '|', $l['cf_images'] ?? '' ) );
    $image_url = '';
    if ( $cf_ids ) {
        $image_url = 'https://imagedelivery.net/' . IRI_CF_ACCOUNT_HASH . '/' . reset( $cf_ids ) . '/fullsize';
    } elseif ( $l['images'] ?? '' ) {
        $raw       = explode( '|', $l['images'] );
        $image_url = trim( $raw[0] ?? '' );
    }

    $schema = [
        '@context' => 'https://schema.org',
        '@type'    => $schema_type,
        'name'     => $l['title_en'] ?? '',
        'url'      => $url,
    ];

    if ( ! empty( $l['description_en'] ) ) $schema['description'] = $l['description_en'];
    if ( $image_url )                       $schema['image']       = $image_url;
    if ( ! empty( $l['last_updated'] ) )    $schema['datePosted']  = $l['last_updated'];

    // Price
    if ( ! empty( $l['price_jpy'] ) ) {
        $schema['offers'] = [
            '@type'         => 'Offer',
            'price'         => (int) $l['price_jpy'],
            'priceCurrency' => 'JPY',
            'availability'  => 'https://schema.org/InStock',
        ];
    }

    // Address
    $addr = [ '@type' => 'PostalAddress', 'addressRegion' => 'Hokkaido', 'addressCountry' => 'JP' ];
    if ( ! empty( $l['address_en'] ) )   $addr['streetAddress']   = $l['address_en'];
    if ( ! empty( $l['municipality'] ) ) $addr['addressLocality'] = $l['municipality'];
    $schema['address'] = $addr;

    // Geo coordinates
    if ( ! empty( $l['lat'] ) && ! empty( $l['lng'] ) ) {
        $schema['geo'] = [
            '@type'     => 'GeoCoordinates',
            'latitude'  => (float) $l['lat'],
            'longitude' => (float) $l['lng'],
        ];
    }

    // Building-specific fields
    if ( ! empty( $l['building_area_sqm'] ) ) {
        $schema['floorSize'] = [
            '@type'    => 'QuantitativeValue',
            'value'    => (float) $l['building_area_sqm'],
            'unitCode' => 'MTK',
        ];
    }
    if ( ! empty( $l['floor_plan_en'] ) ) $schema['numberOfRooms'] = $l['floor_plan_en'];
    if ( ! empty( $l['build_year'] ) )    $schema['yearBuilt']     = (int) $l['build_year'];

    // Land area
    if ( ! empty( $l['land_area_sqm'] ) ) {
        $schema['landSize'] = [
            '@type'    => 'QuantitativeValue',
            'value'    => (float) $l['land_area_sqm'],
            'unitCode' => 'MTK',
        ];
    }

    echo '<script type="application/ld+json">' . "\n";
    echo wp_json_encode( $schema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT );
    echo "\n</script>\n";
}

// ── 2b. Archive output buffer ─────────────────────────────────────────────────
// Starts an output buffer on the listing post-type archive page.
// Works exactly like the single-listing buffer, but processes tokens per-card
// using <!--iri:N--> markers injected by iri_loop_object().

add_action( 'template_redirect', 'iri_start_archive_buffer' );
function iri_start_archive_buffer() {
    if ( ! is_post_type_archive( 'listing' ) ) return;
    if ( is_admin() ) return;
    if ( isset( $_GET['bricks'] ) ) return; // skip Bricks builder preview
    ob_start( 'iri_resolve_archive_tokens_in_output' );
}

function iri_resolve_archive_tokens_in_output( $html ) {
    global $iri_query_listings;
    if ( empty( $iri_query_listings ) ) return $html;

    // Split the page HTML at per-card markers injected by iri_loop_object()
    // e.g. <!--iri:0--> ... card 0 HTML ... <!--iri:1--> ... card 1 HTML ...
    $parts = preg_split( '/<!--iri:(\d+)-->/', $html, -1, PREG_SPLIT_DELIM_CAPTURE );

    if ( count( $parts ) <= 1 ) return $html; // no markers — nothing to do

    $result = $parts[0]; // everything before the first card (nav, filters, etc.)

    for ( $i = 1; $i < count( $parts ); $i += 2 ) {
        $idx     = (int) $parts[ $i ];
        $segment = $parts[ $i + 1 ] ?? '';
        $listing = $iri_query_listings[ $idx ] ?? [];

        if ( $listing ) {
            // Pass 1: {iri_field} and {iri_field|format}
            $segment = preg_replace_callback(
                '/\{iri_([a-z0-9_]+)(?:\|([a-z0-9_]+(?::\d+)?))?\}/i',
                function ( $m ) use ( $listing ) {
                    return iri_format_value( iri_resolve_field( $m[1], $listing ), $m[2] ?? '' );
                },
                $segment
            );

            // Pass 2: {echo:number_format(N)} wrappers Bricks may have added
            $segment = preg_replace_callback(
                '/\{echo:number_format\((-?[\d.]+)(?:,\s*(\d+))?\)\}/',
                function ( $m ) {
                    return number_format( (float) $m[1], isset( $m[2] ) ? (int) $m[2] : 0 );
                },
                $segment
            );
        }

        $result .= $segment;
    }

    return $result;
}

// ── 2c. Body classes for property type — used by CSS to show/hide sections ────
// Adds iri-type-land or iri-type-property to <body> on single listing pages.
// Use these classes in your Bricks template CSS instead of Bricks conditions,
// which evaluate before our output buffer replaces {iri_*} tokens.

add_filter( 'body_class', 'iri_body_classes' );
function iri_body_classes( $classes ) {
    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return $classes;

    $type = strtolower( $iri_current_listing['property_type_en'] ?? '' );

    if ( str_contains( $type, 'land' ) ) {
        $classes[] = 'iri-type-land';
    } else {
        $classes[] = 'iri-type-property';
    }

    return $classes;
}

add_action( 'template_redirect', 'iri_template_redirect' );
function iri_template_redirect() {
    // Guard: only act when our rewrite rule matched.
    $slug = get_query_var( 'iri_slug' );

    // If someone hits /listing/iri-shell/ directly (no iri_slug), send them to 404.
    if ( ! $slug && is_singular( 'listing' ) ) {
        global $wp_query;
        $wp_query->set_404();
        status_header( 404 );
        nocache_headers();
        return;
    }

    if ( ! $slug ) return;

    // Fetch listing data from the Worker API.
    $listing = iri_fetch_by_slug( $slug );

    if ( ! $listing || ! empty( $listing['error'] ) ) {
        global $wp_query;
        $wp_query->set_404();
        status_header( 404 );
        nocache_headers();
        return;
    }

    // Store listing globally so Bricks dynamic tags can access it.
    global $iri_current_listing;
    $iri_current_listing = $listing;

    // Increment view count — fire-and-forget (non-blocking, won't slow page load).
    // Skips bots and WP cron; only counts real front-end page loads.
    if ( ! is_admin() && ! ( defined( 'DOING_CRON' ) && DOING_CRON ) ) {
        $lid = $listing['id'] ?? '';
        if ( $lid ) {
            wp_remote_get(
                IRI_WORKER_URL . '/listings/' . rawurlencode( $lid ) . '/view',
                [ 'blocking' => false, 'timeout' => 3 ]
            );
        }
    }

    // Override the shell post title so Bricks / SEO plugins see the real title.
    global $post;
    if ( $post ) {
        $post->post_title = $listing['title_en'] ?? 'Listing';
        setup_postdata( $post );
    }

    // Set the browser/SEO document title.
    add_filter( 'pre_get_document_title', function() use ( $listing ) {
        return ( $listing['title_en'] ?? 'Listing' ) . ' | ' . get_bloginfo( 'name' );
    } );

    // Enqueue GLightbox on single listing pages for gallery lightbox support
    add_action( 'wp_enqueue_scripts', function() {
        wp_enqueue_style(
            'glightbox',
            'https://cdn.jsdelivr.net/npm/glightbox/dist/css/glightbox.min.css',
            [],
            null
        );
        wp_enqueue_script(
            'glightbox',
            'https://cdn.jsdelivr.net/npm/glightbox/dist/js/glightbox.min.js',
            [],
            null,
            true
        );
        // Initialise GLightbox after the page loads
        wp_add_inline_script( 'glightbox', 'document.addEventListener("DOMContentLoaded",function(){GLightbox({selector:".glightbox"});});' );
    } );

    // ── Output buffer: replace {iri_*} tokens directly in the rendered HTML ──────
    // This works regardless of how Bricks internally handles dynamic data tags.
    ob_start( 'iri_resolve_tokens_in_output' );
}

/**
 * Output buffer callback — runs on the full page HTML just before it's sent
 * to the browser.
 *
 * Pass 1 — replaces {iri_fieldname} and {iri_fieldname|format} tokens.
 *   Supported formats:
 *     {iri_building_area_sqm|number_format}    → 141
 *     {iri_building_area_sqm|number_format:2}  → 140.66
 *
 * Pass 2 — evaluates any leftover {echo:number_format(N)} wrappers that
 *   Bricks generates when its echo tag wraps one of our tokens. After pass 1
 *   replaces the inner token, the wrapper resolves cleanly here.
 */
function iri_resolve_tokens_in_output( $html ) {
    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return $html;

    // Pass 1: {iri_field} and {iri_field|format} / {iri_field|number_format:2}
    $html = preg_replace_callback(
        '/\{iri_([a-z0-9_]+)(?:\|([a-z0-9_]+(?::\d+)?))?\}/i',
        function ( $matches ) use ( $iri_current_listing ) {
            $value = iri_resolve_field( $matches[1], $iri_current_listing );
            return iri_format_value( $value, $matches[2] ?? '' );
        },
        $html
    );

    // Pass 2: {echo:number_format(140.66)} and {echo:number_format(140.66, 2)}
    $html = preg_replace_callback(
        '/\{echo:number_format\((-?[\d.]+)(?:,\s*(\d+))?\)\}/',
        function ( $matches ) {
            $decimals = isset( $matches[2] ) ? (int) $matches[2] : 0;
            return number_format( (float) $matches[1], $decimals );
        },
        $html
    );

    // Pass 3: Replace every occurrence of the shell post title "__iri_shell__"
    // with the real listing title. This fixes breadcrumbs, page titles, and
    // anything else a plugin derives from the shell post object.
    $listing_title = $iri_current_listing['title_en'] ?? '';
    if ( $listing_title ) {
        $html = str_replace( '__iri_shell__', esc_html( $listing_title ), $html );
    }

    // Pass 4: Fix the <title> tag specifically — runs after pass 3 so it
    // also overwrites whatever an SEO plugin built from the shell post.
    if ( $listing_title ) {
        $site_name  = get_bloginfo( 'name' );
        $full_title = esc_html( $listing_title ) . ' &#8211; ' . esc_html( $site_name );
        $html = preg_replace(
            '/<title>[^<]*<\/title>/',
            '<title>' . $full_title . '</title>',
            $html
        );
    }

    return $html;
}

/**
 * Apply an optional format modifier to a resolved field value.
 */
function iri_format_value( $value, $format ) {
    if ( ! $format ) return $value;

    // number_format or number_format:N (decimal places)
    if ( preg_match( '/^number_format(?::(\d+))?$/i', $format, $m ) ) {
        if ( ! is_numeric( $value ) ) return $value;
        return number_format( (float) $value, isset( $m[1] ) ? (int) $m[1] : 0 );
    }

    return $value;
}

/**
 * Resolve a single IRI field name to its value.
 * Handles computed fields; falls back to the raw D1 column value.
 */
function iri_resolve_field( $field, $listing ) {

    if ( $field === '_listing_url' ) {
        $region = $listing['region'] ?? 'hokkaido';
        $area   = $listing['taxonomy_property_area'] ?? 'hokkaido';
        $slug   = $listing['slug'] ?? '';
        return home_url( "/listing/{$region}/{$area}/{$slug}/" );
    }

    // First image — prefers CF Images (thumbnail variant), falls back to raw URL
    if ( $field === '_first_image' ) {
        $cf = $listing['cf_images'] ?? '';
        if ( $cf ) {
            $id = explode( '|', $cf )[0];
            return 'https://imagedelivery.net/' . IRI_CF_ACCOUNT_HASH . '/' . $id . '/medium';
        }
        $raw   = $listing['images'] ?? '';
        $parts = explode( '|', $raw );
        return trim( $parts[0] ?? '' );
    }

    // CF Image URL helpers for a specific variant
    // Usage: {iri__cf_thumbnail_1} → first image at thumbnail size (300×300)
    //        {iri__cf_medium_1}    → first image at medium size (800×600)
    //        {iri__cf_full_1}      → first image at fullsize (1600×1200) — CF variant named "fullsize"
    if ( preg_match( '/^_cf_(thumbnail|medium|full)_(\d+)$/', $field, $m ) ) {
        $variant = $m[1] === 'full' ? 'fullsize' : $m[1]; // CF variant is "fullsize" not "full"
        $index   = (int) $m[2] - 1; // 1-based → 0-based
        $cf      = $listing['cf_images'] ?? '';
        $ids     = array_filter( explode( '|', $cf ) );
        $id      = $ids[ $index ] ?? '';
        if ( ! $id ) return '';
        return 'https://imagedelivery.net/' . IRI_CF_ACCOUNT_HASH . '/' . $id . '/' . $variant;
    }

    // Gallery HTML — full responsive gallery with lightbox-ready markup
    // Usage: place {iri__gallery} in a Bricks HTML element
    if ( $field === '_gallery' ) {
        return iri_build_gallery_html( $listing );
    }

    return $listing[ $field ] ?? '';
}

/**
 * Build a complete image gallery HTML block for a listing.
 * Uses Cloudflare Images variants for thumbnail grid + full-size lightbox links.
 * Drop {iri__gallery} into a Bricks HTML element.
 */
function iri_build_gallery_html( $listing ) {
    $cf_images  = $listing['cf_images']  ?? '';
    $image_alts = $listing['image_alts'] ?? '';
    $hash       = IRI_CF_ACCOUNT_HASH;

    if ( ! $cf_images ) {
        // Fallback: raw scraped URLs, no resizing
        $raw  = $listing['images'] ?? '';
        $urls = array_filter( explode( '|', $raw ) );
        if ( ! $urls ) return '';

        $title = esc_attr( $listing['title_en'] ?? 'Listing' );
        $html  = '<div class="iri-gallery iri-gallery--fallback">';
        foreach ( $urls as $i => $url ) {
            $alt  = esc_attr( $title . ' – photo ' . ( $i + 1 ) );
            $html .= '<a class="glightbox iri-gallery__item" href="' . esc_url( $url ) . '" data-type="image">'
                   . '<img src="' . esc_url( $url ) . '" alt="' . $alt . '" loading="lazy">'
                   . '</a>';
        }
        $html .= '</div>';
        return $html;
    }

    $ids  = array_filter( explode( '|', $cf_images ) );
    $alts = explode( '|', $image_alts );

    $html = '<div class="iri-gallery">';
    foreach ( $ids as $i => $id ) {
        $alt      = esc_attr( $alts[ $i ] ?? ( $listing['title_en'] ?? 'Listing' ) );
        $medium   = 'https://imagedelivery.net/' . $hash . '/' . $id . '/medium';
        $fullsize = 'https://imagedelivery.net/' . $hash . '/' . $id . '/fullsize';
        $html .= '<a class="glightbox iri-gallery__item" href="' . esc_url( $fullsize ) . '" data-type="image">'
               . '<img src="' . esc_url( $medium ) . '" alt="' . $alt . '" loading="lazy">'
               . '</a>';
    }
    $html .= '</div>';

    return $html;
}

// ── 2b. Admin debug footer (shows data state to logged-in admins only) ────────
// Remove this block once you confirm data is flowing correctly.

add_action( 'wp_footer', 'iri_debug_footer' );
function iri_debug_footer() {
    if ( ! current_user_can( 'manage_options' ) ) return;
    if ( ! get_query_var( 'iri_slug' ) && ! is_singular( 'listing' ) ) return;

    global $iri_current_listing;
    $loaded = ! empty( $iri_current_listing );
    echo '<div id="iri-debug" style="position:fixed;bottom:0;left:0;right:0;background:#1d2327;color:#f0f0f1;padding:10px 16px;font:12px/1.6 monospace;z-index:999999;max-height:220px;overflow:auto;">';
    echo '<strong style="color:#f6a800;">IRI Debug</strong> &nbsp;|&nbsp; ';
    echo 'iri_slug: <em>' . esc_html( get_query_var( 'iri_slug' ) ?: '(empty)' ) . '</em> &nbsp;|&nbsp; ';
    echo 'iri_region: <em>' . esc_html( get_query_var( 'iri_region' ) ?: '(empty)' ) . '</em> &nbsp;|&nbsp; ';
    echo 'iri_area: <em>' . esc_html( get_query_var( 'iri_area' ) ?: '(empty)' ) . '</em> &nbsp;|&nbsp; ';
    echo '$iri_current_listing: <strong style="color:' . ( $loaded ? '#5cb85c' : '#d9534f' ) . '">' . ( $loaded ? 'SET ✓' : 'EMPTY ✗' ) . '</strong>';
    if ( $loaded ) {
        echo '<br>title: ' . esc_html( $iri_current_listing['title_en'] ?? 'n/a' );
        echo ' &nbsp;|&nbsp; price: ' . esc_html( $iri_current_listing['price_jpy_display'] ?? 'n/a' );
        echo ' &nbsp;|&nbsp; slug: ' . esc_html( $iri_current_listing['slug'] ?? 'n/a' );
    }
    echo '</div>';
}

// ── 3. API helpers ────────────────────────────────────────────────────────────

function iri_fetch_by_slug( $slug ) {
    $cache_key = 'iri_listing_slug_' . md5( $slug );
    $cached    = get_transient( $cache_key );
    if ( $cached !== false ) return $cached;

    $response = wp_remote_get( IRI_WORKER_URL . '/listings/by-slug/' . rawurlencode( $slug ), [
        'timeout' => 10,
    ] );

    if ( is_wp_error( $response ) ) return null;

    $body = json_decode( wp_remote_retrieve_body( $response ), true );
    if ( ! empty( $body ) && empty( $body['error'] ) ) {
        set_transient( $cache_key, $body, IRI_CACHE_TTL );
    }
    return $body;
}

function iri_fetch_listings( $args = [] ) {
    $cache_key = 'iri_listings_' . md5( serialize( $args ) );
    $cached    = get_transient( $cache_key );
    if ( $cached !== false ) return $cached;

    $url      = add_query_arg( $args, IRI_WORKER_URL . '/listings' );
    $response = wp_remote_get( $url, [ 'timeout' => 10 ] );

    if ( is_wp_error( $response ) ) return [];

    $body = json_decode( wp_remote_retrieve_body( $response ), true );
    if ( ! empty( $body['listings'] ) ) {
        set_transient( $cache_key, $body, IRI_CACHE_TTL );
    }
    return $body;
}

// ── 4. Bricks dynamic data tags ───────────────────────────────────────────────

add_filter( 'bricks/dynamic_data/register_tags', 'iri_register_dynamic_tags' );
function iri_register_dynamic_tags( $tags ) {
    $fields = [
        // Label                         => field key in D1
        'IRI: ID'                        => 'id',
        'IRI: Source URL'                => 'source_url',
        'IRI: Status'                    => 'status',
        'IRI: Title'                     => 'title_en',
        'IRI: Description'               => 'description_en',
        'IRI: Property Type'             => 'property_type_en',
        'IRI: Address'                   => 'address_en',
        'IRI: Municipality'              => 'municipality',
        'IRI: District'                  => 'district',
        'IRI: Latitude'                  => 'lat',
        'IRI: Longitude'                 => 'lng',
        'IRI: Price (JPY)'               => 'price_jpy',
        'IRI: Price Display'             => 'price_jpy_display',
        'IRI: Land Area (sqm)'           => 'land_area_sqm',
        'IRI: Land Area (tsubo)'         => 'land_area_tsubo',
        'IRI: Land Type'                 => 'land_type_en',
        'IRI: Zoning'                    => 'zoning_en',
        'IRI: Orientation'               => 'orientation_en',
        'IRI: Building Coverage %'       => 'building_coverage_pct',
        'IRI: Floor Area Ratio %'        => 'floor_area_ratio_pct',
        'IRI: Building Area (sqm)'       => 'building_area_sqm',
        'IRI: Building Area (tsubo)'     => 'building_area_tsubo',
        'IRI: Structure'                 => 'structure_en',
        'IRI: Build Date'                => 'build_date',
        'IRI: Build Year'                => 'build_year',
        'IRI: Building Age (years)'      => 'building_age_years',
        'IRI: Floor Plan'                => 'floor_plan_en',
        'IRI: Utilities'                 => 'utilities_en',
        'IRI: Transit'                   => 'transit_en',
        'IRI: Schools'                   => 'schools_en',
        'IRI: Handover'                  => 'handover_en',
        'IRI: Commission'                => 'commission_raw',
        'IRI: Last Updated'              => 'last_updated',
        'IRI: Images'                    => 'images',
        'IRI: Image Count'               => 'image_count',
        'IRI: Airport Drive (mins)'      => 'airport_drive_mins',
        'IRI: Airport Drive Text'        => 'airport_drive_text',
        'IRI: Airport Distance (km)'     => 'airport_distance_km',
        'IRI: Slug'                      => 'slug',
        'IRI: Region'                    => 'region',
        'IRI: Area Taxonomy'             => 'taxonomy_property_area',
        'IRI: Listing URL'               => '_listing_url',   // computed
        'IRI: First Image URL'           => '_first_image',   // computed
    ];

    foreach ( $fields as $label => $key ) {
        $tags[] = [
            'name'     => 'iri_' . $key,
            'label'    => $label,
            'group'    => 'IRI Listings',
            'provider' => 'iri',
        ];
    }

    return $tags;
}

add_filter( 'bricks/dynamic_data/get_tag_value', 'iri_get_dynamic_tag_value', 10, 3 );
function iri_get_dynamic_tag_value( $value, $tag, $context ) {
    // Normalise: strip curly braces (some Bricks versions include them)
    // and strip colon-delimited modifier suffixes like ":fallback:0"
    $clean = trim( (string) $tag, '{}' );
    $clean = explode( ':', $clean )[0];

    if ( ! str_starts_with( $clean, 'iri_' ) ) return $value;

    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return '';

    $field = substr( $clean, 4 ); // strip 'iri_' prefix
    return iri_resolve_field( $field, $iri_current_listing );
}

// ── 4b. Shortcode fallback: [iri_field field="price_jpy_display"] ─────────────
// Use in a Bricks Shortcode element. Prefer [iri_card field="..."] — same result.
// [iri_card field="title_en"]         → listing title
// [iri_card field="price_jpy_display"] → formatted price
// [iri_card field="_listing_url"]      → full listing URL
// [iri_card field="_first_image"]      → first image URL (CF or raw)

add_shortcode( 'iri_field', 'iri_field_shortcode' );
function iri_field_shortcode( $atts ) {
    $atts  = shortcode_atts( [ 'field' => '' ], $atts, 'iri_field' );
    $field = sanitize_key( $atts['field'] );
    if ( ! $field ) return '';

    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return '';

    return esc_html( iri_resolve_field( $field, $iri_current_listing ) );
}

// ── 4c. [iri_cards] / [iri_map] — JS-driven archive components ────────────────
//
// Place these in your Bricks archive template via Shortcode elements:
//   [iri_map]   — renders the Google Map container + enqueues assets
//   [iri_cards] — renders the card grid container
//
// Filter/sort controls: add Bricks Select elements with these IDs:
//   iri-filter-area   (options auto-populated from live data)
//   iri-filter-type   (options auto-populated from live data)
//   iri-sort          (add options manually: recent / price_asc / price_desc)
//
// Listing count: add any element with id="iri-listing-count" to show total.

add_shortcode( 'iri_map', 'iri_map_shortcode' );
function iri_map_shortcode( $atts ) {
    $atts = shortcode_atts( [ 'height' => '480' ], $atts, 'iri_map' );
    iri_enqueue_archive_assets();
    return '<div id="iri-map" class="iri-map" style="height:' . (int) $atts['height'] . 'px"></div>';
}

add_shortcode( 'iri_cards', 'iri_cards_shortcode' );
function iri_cards_shortcode( $atts ) {
    iri_enqueue_archive_assets();
    return '<div id="iri-card-grid" class="iri-card-grid"></div>';
}

function iri_enqueue_archive_assets() {
    static $done = false;
    if ( $done ) return;
    $done = true;

    // IRI_ARCHIVE_CONFIG is output globally via wp_head (section 0 at top of file).

    // Archive JS — loaded from plugin folder, updated automatically via Git Updater
    wp_enqueue_script(
        'iri-archive',
        plugin_dir_url( __FILE__ ) . 'iri-archive.js',
        [],
        filemtime( plugin_dir_path( __FILE__ ) . 'iri-archive.js' ),
        true  // load in footer
    );

    // Google Maps — loads async; fires window.iriMapReady when ready
    if ( defined( 'IRI_MAPS_KEY' ) && IRI_MAPS_KEY && IRI_MAPS_KEY !== 'YOUR_GOOGLE_MAPS_KEY' ) {
        wp_enqueue_script(
            'google-maps',
            'https://maps.googleapis.com/maps/api/js?key=' . IRI_MAPS_KEY . '&callback=iriMapReady&loading=async',
            [ 'iri-archive' ],
            null,
            true
        );
    }
}

// ── 4d. [iri_card] shortcode — renders one listing card from $iri_current_listing ─
// Use inside a Bricks Shortcode element placed within the IRI Listings loop.
// Alternatively, use [iri field="title_en"] for individual fields.

add_shortcode( 'iri_card', 'iri_card_shortcode' );
function iri_card_shortcode( $atts ) {
    global $iri_current_listing;
    if ( empty( $iri_current_listing ) ) return '';

    $atts = shortcode_atts( [ 'field' => '' ], $atts, 'iri_card' );

    // [iri_card field="title_en"] — return a single field value
    if ( ! empty( $atts['field'] ) ) {
        $field = sanitize_key( $atts['field'] );
        return esc_html( iri_resolve_field( $field, $iri_current_listing ) );
    }

    // [iri_card] — render the full listing card
    $l      = $iri_current_listing;
    $title  = esc_html( $l['title_en'] ?? 'Listing' );
    $price  = esc_html( $l['price_jpy_display'] ?? '' );
    $area   = esc_html( ucwords( str_replace( '-', ' ', $l['taxonomy_property_area'] ?? '' ) ) );
    $type   = esc_html( $l['property_type_en'] ?? '' );
    $sqm    = $l['land_area_sqm'] ? number_format( (float) $l['land_area_sqm'] ) . ' m²' : '';
    $region = $l['region'] ?? 'hokkaido';
    $slug   = $l['slug'] ?? '';
    $url    = home_url( "/listing/{$region}/{$area_raw}/{$slug}/" );

    // Use raw area value for URL (not ucwords'd)
    $area_raw = $l['taxonomy_property_area'] ?? '';
    $url      = home_url( "/listing/{$region}/{$area_raw}/{$slug}/" );

    // Image: prefer Cloudflare Images thumbnail, fall back to raw scraped URL
    $cf_ids = array_filter( explode( '|', $l['cf_images'] ?? '' ) );
    if ( $cf_ids ) {
        $img_url = 'https://imagedelivery.net/' . IRI_CF_ACCOUNT_HASH . '/' . reset( $cf_ids ) . '/thumbnail';
    } else {
        $raw_parts = explode( '|', $l['images'] ?? '' );
        $img_url   = trim( $raw_parts[0] ?? '' );
    }

    ob_start();
    ?>
    <a href="<?= esc_url( $url ) ?>" class="iri-card">
        <?php if ( $img_url ) : ?>
        <div class="iri-card__image">
            <img src="<?= esc_url( $img_url ) ?>" alt="<?= $title ?>" loading="lazy">
        </div>
        <?php endif; ?>
        <div class="iri-card__body">
            <h3 class="iri-card__title"><?= $title ?></h3>
            <?php if ( $price ) : ?>
            <p class="iri-card__price"><?= $price ?></p>
            <?php endif; ?>
            <p class="iri-card__meta">
                <?= $area ?>
                <?php if ( $type ) echo ' &middot; ' . $type; ?>
                <?php if ( $sqm ) echo ' &middot; ' . esc_html( $sqm ); ?>
            </p>
        </div>
    </a>
    <?php
    return ob_get_clean();
}

// ── 5. Bricks query loop for listing archives ──────────────────────────────────
// Registers a custom "IRI Listings" query type in Bricks query loop element.

add_filter( 'bricks/setup/control_options', 'iri_add_query_type' );
function iri_add_query_type( $control_options ) {
    $control_options['queryTypes']['iri_listings'] = esc_html__( 'IRI Listings', 'iri' );
    return $control_options;
}

add_filter( 'bricks/query/run', 'iri_run_query', 10, 2 );
function iri_run_query( $results, $query_obj ) {
    if ( ( $query_obj->object_type ?? '' ) !== 'iri_listings' ) return $results;

    $settings = $query_obj->settings ?? [];

    // Build args from Bricks query settings or URL params
    $args = [ 'limit' => $settings['posts_per_page'] ?? 24 ];

    if ( ! empty( $settings['iri_type'] ) )     $args['type']      = $settings['iri_type'];
    if ( ! empty( $settings['iri_area'] ) )     $args['area']      = $settings['iri_area'];
    if ( ! empty( $settings['iri_price_min'] ) ) $args['price_min'] = $settings['iri_price_min'];
    if ( ! empty( $settings['iri_price_max'] ) ) $args['price_max'] = $settings['iri_price_max'];

    // Allow URL params to override (for filter integration)
    foreach ( [ 'type', 'area', 'price_min', 'price_max', 'status' ] as $param ) {
        $val = $_GET[ 'iri_' . $param ] ?? '';
        if ( $val !== '' ) $args[ $param ] = sanitize_text_field( $val );
    }

    $data = iri_fetch_listings( $args );

    global $iri_query_listings;
    $iri_query_listings = $data['listings'] ?? [];

    return $iri_query_listings;
}

add_filter( 'bricks/query/loop_object', 'iri_loop_object', 10, 3 );
function iri_loop_object( $loop_object, $loop_key, $query_obj ) {
    if ( ( $query_obj->object_type ?? '' ) !== 'iri_listings' ) return $loop_object;

    global $iri_current_listing, $iri_query_listings, $post;
    $iri_current_listing = $iri_query_listings[ $loop_key ] ?? [];

    // Inject a marker into the output stream so the archive buffer knows which
    // listing's data to use when replacing {iri_*} tokens in this card's HTML.
    echo '<!--iri:' . (int) $loop_key . '-->';

    // Set up the shell post so Bricks' dynamic data filter activates per card.
    $shell_id = iri_get_shell_post_id();
    if ( $shell_id ) {
        $post = get_post( $shell_id );
        setup_postdata( $post );
    }

    return $loop_object;
}

// ── 6. Helper: flush cache for a listing (call after import) ──────────────────

function iri_flush_listing_cache( $slug ) {
    delete_transient( 'iri_listing_slug_' . md5( $slug ) );
}

// ── 7. Admin: flush all IRI transients ───────────────────────────────────────

add_action( 'admin_bar_menu', 'iri_admin_bar_flush', 999 );
function iri_admin_bar_flush( $wp_admin_bar ) {
    if ( ! current_user_can( 'manage_options' ) ) return;
    $wp_admin_bar->add_node( [
        'id'    => 'iri-flush-cache',
        'title' => 'Flush IRI Cache',
        'href'  => add_query_arg( 'iri_flush_cache', '1', home_url() ),
    ] );
}

add_action( 'init', 'iri_handle_flush_cache' );
function iri_handle_flush_cache() {
    if ( ! isset( $_GET['iri_flush_cache'] ) ) return;
    if ( ! current_user_can( 'manage_options' ) ) return;

    global $wpdb;
    $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_iri_%'" );
    $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_timeout_iri_%'" );

    wp_redirect( remove_query_arg( 'iri_flush_cache' ) );
    exit;
}
