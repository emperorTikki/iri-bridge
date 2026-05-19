/**
 * iri-archive.js
 * JS-driven archive for IRI real estate listings.
 *
 * – Fetches all listings from the Cloudflare Worker API on page load
 * – Renders card grid with land / non-land variants
 * – Drives Google Map with listing markers + info-window cards
 * – Handles filter (area, type) and sort (price asc/desc, recent) instantly,
 *   updating both the card grid and map markers together from the same dataset
 *
 * Config is passed via wp_localize_script as window.IRI_ARCHIVE_CONFIG:
 *   workerUrl  — Worker base URL (no trailing slash)
 *   cfHash     — Cloudflare Images account hash
 *   limit      — max listings to fetch (default 500)
 *
 * Required element IDs in the page (add via Bricks):
 *   iri-card-grid      — container where cards are rendered
 *   iri-map            — container for Google Map
 *   iri-filter-area    — <select> for area filter (options auto-populated)
 *   iri-filter-type    — <select> for property type filter (options auto-populated)
 *   iri-sort           — <select> for sort order
 *   iri-listing-count  — (optional) element whose text is updated with result count
 */

( function () {
  'use strict';

  const CFG     = window.IRI_ARCHIVE_CONFIG || {};
  const WORKER  = CFG.workerUrl || '';
  const CF_HASH = CFG.cfHash   || '';
  const LIMIT   = CFG.limit    || 500;

  const PAGE_SIZE = 21;   // cards shown per "Load More" click (3-column grid — multiple of 3)

  let allListings     = [];   // full unfiltered dataset
  let currentFiltered = [];   // filtered/sorted result (full)
  let currentPage     = 1;    // how many pages have been revealed
  let mapInstance     = null;
  let infoWindow      = null;
  let markerList      = [];

  // ── Utility ─────────────────────────────────────────────────────────────────

  function esc( str ) {
    return String( str || '' )
      .replace( /&/g, '&amp;' )
      .replace( /</g, '&lt;'  )
      .replace( />/g, '&gt;'  )
      .replace( /"/g, '&quot;' );
  }

  function numFmt( n ) {
    const num = parseFloat( n );
    return isNaN( num ) ? '' : Math.round( num ).toLocaleString();
  }

  function isLand( listing ) {
    return ( listing.property_type_en || '' ).toLowerCase().includes( 'land' );
  }

  function imageUrl( listing ) {
    const ids = ( listing.cf_images || '' ).split( '|' ).filter( Boolean );
    if ( ids.length && CF_HASH ) {
      return `https://imagedelivery.net/${ CF_HASH }/${ ids[0] }/thumbnail`;
    }
    const raw = ( listing.images || '' ).split( '|' ).filter( Boolean );
    return raw[0] || '';
  }

  function listingUrl( l ) {
    return `/listing/${ l.region }/${ l.taxonomy_property_area }/${ l.slug }/`;
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────

  async function fetchAll() {
    const resp = await fetch( `${ WORKER }/listings?limit=${ LIMIT }` );
    if ( ! resp.ok ) throw new Error( `Worker HTTP ${ resp.status }` );
    const data = await resp.json();
    return data.listings || [];
  }

  async function fetchPage( limit ) {
    const resp = await fetch( `${ WORKER }/listings?limit=${ limit }` );
    if ( ! resp.ok ) throw new Error( `Worker HTTP ${ resp.status }` );
    const data = await resp.json();
    return data.listings || [];
  }

  // ── Filter & sort ────────────────────────────────────────────────────────────

  function getControls() {
    const minEl   = document.getElementById( 'iri-price-min' );
    const maxEl   = document.getElementById( 'iri-price-max' );
    const areaRaw = document.getElementById( 'iri-filter-area' )?.value || '';
    const isGroup = areaRaw.startsWith( 'group:' );
    return {
      area        : isGroup ? '' : areaRaw.replace( 'area:', '' ),
      group       : isGroup ? areaRaw.replace( 'group:', '' ) : '',
      type        : document.getElementById( 'iri-filter-type' )?.value || '',
      sort        : document.getElementById( 'iri-sort' )?.value        || 'recent',
      priceMin    : minEl ? parseInt( minEl.value ) : 0,
      priceMax    : maxEl ? parseInt( maxEl.value ) : Infinity,
      priceAbsMax : maxEl ? parseInt( maxEl.max )   : Infinity,
    };
  }

  function applyControls( listings ) {
    const { area, group, type, sort, priceMin, priceMax, priceAbsMax } = getControls();
    let out = [ ...listings ];

    if ( group ) out = out.filter( l => l.area_group === group );
    else if ( area ) out = out.filter( l => l.taxonomy_property_area === area );

    if ( type ) out = out.filter( l => ( l.taxonomy_property_type || '' ).toLowerCase() === type.toLowerCase() );

    // Price range — only filter if sliders have been moved from their defaults
    if ( priceMin > 0 )
      out = out.filter( l => ( l.price_jpy || 0 ) >= priceMin );
    if ( priceMax < priceAbsMax )
      out = out.filter( l => ( l.price_jpy || 0 ) <= priceMax );

    if ( sort === 'price_asc'  ) out.sort( ( a, b ) => ( a.price_jpy || 0 ) - ( b.price_jpy || 0 ) );
    if ( sort === 'price_desc' ) out.sort( ( a, b ) => ( b.price_jpy || 0 ) - ( a.price_jpy || 0 ) );
    if ( sort === 'recent'     ) out.sort( ( a, b ) =>
      new Date( b.first_seen_at || b.active_at || b.scraped_at || 0 ) - new Date( a.first_seen_at || a.active_at || a.scraped_at || 0 )
    );

    return out;
  }

  // ── Price slider ─────────────────────────────────────────────────────────────

  function fmtPrice( yen, isMax, absMax ) {
    const label = '¥' + ( yen / 1000000 ).toFixed( 1 ) + 'M';
    return ( isMax && yen >= absMax ) ? label + '+' : label;
  }

  function updateSliderTrack() {
    const minEl    = document.getElementById( 'iri-price-min' );
    const maxEl    = document.getElementById( 'iri-price-max' );
    const trackEl  = document.getElementById( 'iri-price-track' );
    if ( ! minEl || ! maxEl || ! trackEl ) return;
    const rMin   = parseInt( minEl.min );
    const rMax   = parseInt( minEl.max );
    const minPct = ( ( parseInt( minEl.value ) - rMin ) / ( rMax - rMin ) ) * 100;
    const maxPct = ( ( parseInt( maxEl.value ) - rMin ) / ( rMax - rMin ) ) * 100;
    trackEl.style.background = `linear-gradient(to right,
      var(--iri-slider-inactive, #d1d5db) ${ minPct }%,
      var(--iri-slider-active,   #22c55e) ${ minPct }%,
      var(--iri-slider-active,   #22c55e) ${ maxPct }%,
      var(--iri-slider-inactive, #d1d5db) ${ maxPct }%)`;
  }

  function updatePriceLabels() {
    const minEl      = document.getElementById( 'iri-price-min' );
    const maxEl      = document.getElementById( 'iri-price-max' );
    const minLabel   = document.getElementById( 'iri-price-min-label' );
    const maxLabel   = document.getElementById( 'iri-price-max-label' );
    if ( minEl && minLabel ) minLabel.textContent = fmtPrice( parseInt( minEl.value ), false, 0 );
    if ( maxEl && maxLabel ) maxLabel.textContent = fmtPrice( parseInt( maxEl.value ), true, parseInt( maxEl.max ) );
    updateSliderTrack();
  }

  function initPriceSlider( listings ) {
    const minEl = document.getElementById( 'iri-price-min' );
    const maxEl = document.getElementById( 'iri-price-max' );
    if ( ! minEl || ! maxEl ) return;

    // Calculate range from actual data
    const prices = listings.map( l => l.price_jpy ).filter( Boolean );
    if ( ! prices.length ) return;

    const step      = 500000; // ¥500k steps
    const dataMin   = Math.floor( Math.min( ...prices ) / step ) * step;
    const dataMax   = Math.ceil(  Math.max( ...prices ) / step ) * step;

    [ minEl, maxEl ].forEach( el => {
      el.min  = dataMin;
      el.max  = dataMax;
      el.step = step;
    } );
    minEl.value = dataMin;
    maxEl.value = dataMax;

    // Inject custom track element once (sits behind both range inputs)
    const slidersEl = minEl.closest( '.iri-price-sliders' ) || minEl.parentElement;
    if ( slidersEl && ! document.getElementById( 'iri-price-track' ) ) {
      const track = document.createElement( 'div' );
      track.id = 'iri-price-track';
      slidersEl.insertBefore( track, slidersEl.firstChild );
    }

    updatePriceLabels();

    // Only bind events once
    if ( minEl.dataset.iriSliderBound ) return;
    minEl.dataset.iriSliderBound = '1';

    minEl.addEventListener( 'input', () => {
      if ( parseInt( minEl.value ) > parseInt( maxEl.value ) ) minEl.value = maxEl.value;
      updatePriceLabels();
      update();
    } );
    maxEl.addEventListener( 'input', () => {
      if ( parseInt( maxEl.value ) < parseInt( minEl.value ) ) maxEl.value = minEl.value;
      updatePriceLabels();
      update();
    } );
  }

  // ── Card rendering ───────────────────────────────────────────────────────────

  function zoningBadge( score ) {
    const cls = ( score >= 5 ) ? 'iri-zoning-green'
              : ( score >= 2 ) ? 'iri-zoning-yellow'
              :                  'iri-zoning-grey';
    return `<span class="iri-zoning-badge iri-zoning-compact ${ cls }">` +
             `<span class="iri-zoning-badge__label">STR</span>` +
             `<span class="iri-zoning-badge__dot"></span>` +
           `</span>`;
  }

  function cardHTML( l ) {
    const land = isLand( l );
    const img  = imageUrl( l );
    const url  = listingUrl( l );

    let statusBadge = '';
    if ( l.status === 'sold' )           statusBadge = `<span class="iri-status-badge iri-status-badge--sold">Sold</span>`;
    else if ( l.status === 'under_contract' ) statusBadge = `<span class="iri-status-badge iri-status-badge--contract">Under Contract</span>`;

    const imgBlock = img
      ? `<div class="iri-card__image">${ statusBadge }<img src="${ esc( img ) }" alt="${ esc( l.title_en ) }" loading="lazy" itemprop="image"></div>`
      : `<div class="iri-card__image iri-card__image--none">${ statusBadge }</div>`;

    // Specs row: land shows land area; non-land shows floor plan + building area + build year + STR badge
    let specs = '';
    if ( land ) {
      if ( l.land_area_sqm ) specs += `<span class="iri-spec">${ numFmt( l.land_area_sqm ) } m²</span>`;
    } else {
      if ( l.floor_plan_en     ) specs += `<span class="iri-spec">${ esc( l.floor_plan_en ) }</span>`;
      if ( l.building_area_sqm ) specs += `<span class="iri-spec">${ numFmt( l.building_area_sqm ) } m²</span>`;
      if ( l.build_year        ) specs += `<span class="iri-spec">Built ${ esc( l.build_year ) }</span>`;
    }
    if ( l.zoning_score !== null && l.zoning_score !== undefined ) {
      specs += `<span class="iri-spec">${ zoningBadge( l.zoning_score ) }</span>`;
    }

    // Schema.org type — mirrors what the PHP JSON-LD outputs for single listing pages
    const schemaType = land
      ? 'https://schema.org/LandOrCottage'
      : ( l.property_type_en || '' ).toLowerCase().includes( 'condo' )
        ? 'https://schema.org/Apartment'
        : 'https://schema.org/SingleFamilyResidence';

    return `<a href="${ esc( url ) }" class="iri-card${ land ? ' iri-card--land' : ' iri-card--property' }"
        itemscope itemtype="${ schemaType }">
      <link itemprop="url" href="${ esc( url ) }">
      ${ imgBlock }
      <div class="iri-card__body">
        <p class="iri-card__price" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <span itemprop="price" content="${ l.price_jpy || '' }">${ esc( l.price_jpy_display || '' ) }</span>
          <meta itemprop="priceCurrency" content="JPY">
        </p>
        <h3 class="iri-card__title" itemprop="name">${ esc( l.title_en || '' ) }</h3>
        <p class="iri-card__address" itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
          <span itemprop="streetAddress">${ esc( l.address_en || '' ) }</span>
          <meta itemprop="addressRegion" content="Hokkaido">
          <meta itemprop="addressCountry" content="JP">
        </p>
        ${ specs ? `<div class="iri-card__specs">${ specs }</div>` : '' }
      </div>
    </a>`;
  }

  // Inject fade-in animation for new cards once
  ( function injectLoadMoreCSS() {
    if ( document.getElementById( 'iri-load-more-css' ) ) return;
    const s = document.createElement( 'style' );
    s.id = 'iri-load-more-css';
    s.textContent = `
      @keyframes iri-fade-up {
        from { opacity: 0; transform: scale(0.98); }
        to   { opacity: 1; transform: scale(1);    }
      }
      .iri-card--new {
        animation: iri-fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .iri-card__image { position: relative; }
      .iri-status-badge {
        position: absolute; bottom: 0; left: 0; right: 0;
        text-align: center; font-size: 0.72rem; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase;
        padding: 5px 0; z-index: 2; pointer-events: none;
      }
      .iri-status-badge--sold     { background: rgba(18,18,18,0.80); color: #fff; }
      .iri-status-badge--contract { background: rgba(180,95,0,0.85);  color: #fff; }
    `;
    document.head.appendChild( s );
  } )();

  function renderGrid( listings, append = false ) {
    const el = document.getElementById( 'iri-card-grid' );
    if ( ! el ) return;

    const prevCount = append ? ( currentPage - 1 ) * PAGE_SIZE : 0;
    const visible   = listings.slice( 0, currentPage * PAGE_SIZE );
    const newItems  = append ? listings.slice( prevCount, currentPage * PAGE_SIZE ) : visible;
    const total     = listings.length;
    const showing   = visible.length;

    // Count display — updates ALL elements with id="iri-showing" or class="iri-showing"
    // Template tokens: {to} = visible count, {total} = total filtered count
    // Set your wording in Bricks, e.g. "Showing 1–{to} of {total} listings"
    // Falls back to a default if the element is empty.
    document.querySelectorAll( '#iri-showing, .iri-showing' ).forEach( el => {
      if ( ! el.dataset.iriTemplate ) {
        const raw = el.textContent.trim();
        el.dataset.iriTemplate = raw || 'Showing 1–{to} of {total} listings';
      }
      el.textContent = total === 0
        ? 'No listings found'
        : el.dataset.iriTemplate
            .replace( '{to}',    showing )
            .replace( '{total}', total );
    } );

    // Load More button — hide when everything is visible
    const moreBtn = document.getElementById( 'iri-load-more' );
    if ( moreBtn ) moreBtn.style.display = showing >= total ? 'none' : '';

    if ( ! total ) {
      el.innerHTML = '<p class="iri-no-results">No listings match your filters.</p>';
      return;
    }

    if ( append ) {
      // Append only new cards with staggered cascade animation (Option D)
      newItems.forEach( ( l, i ) => {
        const tmp = document.createElement( 'div' );
        tmp.innerHTML = cardHTML( l );
        const card = tmp.firstElementChild;
        card.classList.add( 'iri-card--new' );
        card.style.animationDelay = `${ Math.min( i, 6 ) * 80 }ms`; // 80ms stagger, capped at 480ms
        el.appendChild( card );
      } );
    } else {
      el.innerHTML = '';
      visible.forEach( ( l, i ) => {
        const tmp = document.createElement( 'div' );
        tmp.innerHTML = cardHTML( l );
        const card = tmp.firstElementChild;
        card.classList.add( 'iri-card--new' );
        card.style.animationDelay = `${ Math.min( i, 6 ) * 80 }ms`;
        el.appendChild( card );
      } );
    }
  }

  // ── Google Map ───────────────────────────────────────────────────────────────

  function mapInfoCardHTML( l ) {
    const img = imageUrl( l );
    const url = listingUrl( l );
    const land = isLand( l );

    let specs = '';
    if ( land ) {
      if ( l.land_area_sqm ) specs = `${ numFmt( l.land_area_sqm ) } m²`;
    } else {
      const parts = [];
      if ( l.floor_plan_en     ) parts.push( esc( l.floor_plan_en ) );
      if ( l.building_area_sqm ) parts.push( `${ numFmt( l.building_area_sqm ) } m²` );
      if ( l.build_year        ) parts.push( `Built ${ l.build_year }` );
      specs = parts.join( ' · ' );
    }

    return `<div class="iri-map-card">
      ${ img ? `<img src="${ esc( img ) }" alt="${ esc( l.title_en ) }">` : '' }
      <div class="iri-map-card__body">
        <p class="iri-map-card__price">${ esc( l.price_jpy_display || '' ) }</p>
        <h4 class="iri-map-card__title">${ esc( l.title_en || '' ) }</h4>
        ${ specs ? `<p class="iri-map-card__specs">${ specs }</p>` : '' }
        <p class="iri-map-card__meta">${ esc( l.property_type_en || '' ) }${ l.taxonomy_property_area ? ' · ' + esc( l.taxonomy_property_area ) : '' }</p>
        <a class="iri-map-card__link" href="${ esc( url ) }">View listing →</a>
      </div>
    </div>`;
  }

  function initMap() {
    const el = document.getElementById( 'iri-map' );
    if ( ! el || typeof google === 'undefined' ) return;

    mapInstance = new google.maps.Map( el, {
      center           : { lat: 43.77, lng: 142.37 }, // Asahikawa centre
      zoom             : 10,
      mapTypeControl   : false,
      streetViewControl: false,
      fullscreenControl: true,
    } );
    infoWindow = new google.maps.InfoWindow( { maxWidth: 240 } );
  }

  function renderMarkers( listings ) {
    if ( ! mapInstance ) return;

    // Remove old markers
    markerList.forEach( m => m.setMap( null ) );
    markerList = [];

    listings.forEach( l => {
      const lat = parseFloat( l.lat );
      const lng = parseFloat( l.lng );
      if ( ! lat || ! lng ) return;

      const marker = new google.maps.Marker( {
        position : { lat, lng },
        map      : mapInstance,
        title    : l.title_en,
      } );

      marker.addListener( 'click', () => {
        infoWindow.setContent( mapInfoCardHTML( l ) );
        infoWindow.open( mapInstance, marker );
      } );

      markerList.push( marker );
    } );
  }

  // ── Populate filter dropdowns from live data ─────────────────────────────────

  function populateFilters( listings, areaGroups ) {
    // Area dropdown — grouped hierarchy, only showing areas with active listings
    const areaEl = document.getElementById( 'iri-filter-area' );
    if ( areaEl && ! areaEl.dataset.iriPopulated && areaGroups ) {
      // Build set of area slugs that have at least one listing
      const activeAreas = new Set( listings.map( l => l.taxonomy_property_area ).filter( Boolean ) );

      Object.entries( areaGroups ).forEach( ( [ groupSlug, group ] ) => {
        const visibleAreas = group.areas.filter( a => activeAreas.has( a.slug ) );
        if ( visibleAreas.length === 0 ) return; // skip group if no active listings

        // Group-level selectable option — filters all areas in the group
        const og = document.createElement( 'option' );
        og.value       = 'group:' + groupSlug;
        og.textContent = group.label;
        areaEl.appendChild( og );

        // Individual area options — indented under the group
        visibleAreas.forEach( area => {
          const o = document.createElement( 'option' );
          o.value       = 'area:' + area.slug;
          o.textContent = '   └ ' + area.label;
          areaEl.appendChild( o );
        } );
      } );
      areaEl.dataset.iriPopulated = '1';
    }

    // Type dropdown — unique taxonomy_property_type values from data
    const typeEl = document.getElementById( 'iri-filter-type' );
    if ( typeEl && ! typeEl.dataset.iriPopulated ) {
      const types = [ ...new Set( listings.map( l => l.taxonomy_property_type ).filter( Boolean ) ) ].sort();
      types.forEach( t => {
        const o = document.createElement( 'option' );
        o.value       = t;
        o.textContent = t;
        typeEl.appendChild( o );
      } );
      typeEl.dataset.iriPopulated = '1';
    }
  }

  // ── Update both grid and map when filters/sort change ───────────────────────

  function update() {
    currentPage     = 1;  // reset to first page on any filter/sort change
    currentFiltered = applyControls( allListings );
    renderGrid( currentFiltered );
    renderMarkers( currentFiltered );
  }

  function loadMore() {
    const prevPage = currentPage;
    currentPage++;
    renderGrid( currentFiltered, true ); // append mode — only new cards added

    // Scroll to first new card so user sees where new content begins
    const el = document.getElementById( 'iri-card-grid' );
    if ( el ) {
      const allCards = el.querySelectorAll( '.iri-card' );
      const firstNew = allCards[ prevPage * PAGE_SIZE ];
      if ( firstNew ) {
        // Position first new card at 60% down the viewport — keeps previous row visible above
        const y = firstNew.getBoundingClientRect().top + window.scrollY - ( window.innerHeight * 0.6 );
        window.scrollTo( { top: y, behavior: 'smooth' } );
      }
    }
  }

  // ── URL param helper ─────────────────────────────────────────────────────────

  function applyUrlParams() {
    const urlParams = new URLSearchParams( window.location.search );
    const urlGroup  = urlParams.get( 'group' );
    const urlArea   = urlParams.get( 'area' );
    const areaEl    = document.getElementById( 'iri-filter-area' );
    if ( areaEl ) {
      if ( urlGroup ) areaEl.value = 'group:' + urlGroup;
      else if ( urlArea ) areaEl.value = 'area:' + urlArea;
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  // Two-phase load:
  //   Phase 1 — fetch first PAGE_SIZE listings → render immediately (fast first paint)
  //   Phase 2 — fetch all listings + area groups in background → update filters + grid

  async function init() {
    const gridEl = document.getElementById( 'iri-card-grid' );
    const mapEl  = document.getElementById( 'iri-map' );
    if ( ! gridEl && ! mapEl ) return;

    if ( gridEl ) gridEl.innerHTML = '<p class="iri-loading">Loading listings…</p>';

    // Bind controls early so they're ready the moment Phase 1 renders
    [ 'iri-filter-area', 'iri-filter-type', 'iri-sort' ].forEach( id => {
      document.getElementById( id )?.addEventListener( 'change', update );
    } );
    document.getElementById( 'iri-load-more' )?.addEventListener( 'click', loadMore );

    // ── Phase 1: first page renders immediately ────────────────────────────────
    try {
      allListings     = await fetchPage( PAGE_SIZE );
      currentFiltered = applyControls( allListings );
      initPriceSlider( allListings );
      renderGrid( currentFiltered );
    } catch ( e ) {
      console.error( 'IRI archive: phase 1 failed', e );
      if ( gridEl ) gridEl.innerHTML = '<p class="iri-no-results">Could not load listings. Please try again.</p>';
      return;
    }

    // Subtle banner while rest of data loads
    const firstShowingEl = document.querySelector( '#iri-showing, .iri-showing' );
    const bgBanner  = document.createElement( 'span' );
    bgBanner.id          = 'iri-bg-loading';
    bgBanner.textContent = ' · loading more…';
    bgBanner.style.cssText = 'font-size:0.85em;opacity:0.55;';
    if ( firstShowingEl ) firstShowingEl.appendChild( bgBanner );

    // ── Phase 2: full dataset + area groups in background ─────────────────────
    let areaGroups = null;
    try {
      [ allListings, areaGroups ] = await Promise.all( [
        fetchAll(),
        fetch( WORKER + '/area-groups' ).then( r => r.json() ).then( d => d.groups ).catch( () => null ),
      ] );
    } catch ( e ) {
      console.error( 'IRI archive: phase 2 failed', e );
      bgBanner.remove();
      return; // Phase 1 results still visible — graceful degradation
    }

    bgBanner.remove();

    // Populate area filter dropdown + price slider with full data
    populateFilters( allListings, areaGroups );
    initPriceSlider( allListings );

    // Apply URL params now that dropdown is populated
    applyUrlParams();

    // Recompute filtered set with full dataset
    currentFiltered = applyControls( allListings );

    // Re-render grid only if user is still on page 1 (hasn't paginated yet)
    if ( currentPage === 1 ) {
      renderGrid( currentFiltered );
    }

    // Map — full dataset
    if ( typeof google !== 'undefined' ) {
      initMap();
      renderMarkers( currentFiltered );
    }
  }

  // Called by Google Maps API script when Maps is ready (callback=iriMapReady)
  window.iriMapReady = function () {
    initMap();
    renderMarkers( applyControls( allListings ) );
  };

  if ( document.readyState === 'loading' ) {
    document.addEventListener( 'DOMContentLoaded', init );
  } else {
    init();
  }

} )();
