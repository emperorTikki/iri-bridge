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

  const PAGE_SIZE = 20;   // cards shown per "Load More" click

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

  // ── Filter & sort ────────────────────────────────────────────────────────────

  function getControls() {
    const minEl = document.getElementById( 'iri-price-min' );
    const maxEl = document.getElementById( 'iri-price-max' );
    return {
      area     : document.getElementById( 'iri-filter-area' )?.value || '',
      type     : document.getElementById( 'iri-filter-type' )?.value || '',
      sort     : document.getElementById( 'iri-sort' )?.value        || 'recent',
      priceMin : minEl ? parseInt( minEl.value ) : 0,
      priceMax : maxEl ? parseInt( maxEl.value ) : Infinity,
      priceAbsMax : maxEl ? parseInt( maxEl.max ) : Infinity,
    };
  }

  function applyControls( listings ) {
    const { area, type, sort, priceMin, priceMax, priceAbsMax } = getControls();
    let out = [ ...listings ];

    if ( area ) out = out.filter( l => l.taxonomy_property_area === area );

    if ( type ) out = out.filter( l => ( l.taxonomy_property_type || '' ).toLowerCase() === type.toLowerCase() );

    // Price range — only filter if sliders have been moved from their defaults
    if ( priceMin > 0 )
      out = out.filter( l => ( l.price_jpy || 0 ) >= priceMin );
    if ( priceMax < priceAbsMax )
      out = out.filter( l => ( l.price_jpy || 0 ) <= priceMax );

    if ( sort === 'price_asc'  ) out.sort( ( a, b ) => ( a.price_jpy || 0 ) - ( b.price_jpy || 0 ) );
    if ( sort === 'price_desc' ) out.sort( ( a, b ) => ( b.price_jpy || 0 ) - ( a.price_jpy || 0 ) );
    if ( sort === 'recent'     ) out.sort( ( a, b ) =>
      new Date( b.last_updated || b.scraped_at || 0 ) - new Date( a.last_updated || a.scraped_at || 0 )
    );

    return out;
  }

  // ── Price slider ─────────────────────────────────────────────────────────────

  function fmtPrice( yen, isMax, absMax ) {
    const label = yen >= 100000000
      ? '¥' + ( yen / 100000000 ).toFixed( 1 ) + '億'
      : '¥' + ( yen / 1000000 ).toFixed( 1 ) + 'M';
    return ( isMax && yen >= absMax ) ? label + '+' : label;
  }

  function updatePriceLabels() {
    const minEl      = document.getElementById( 'iri-price-min' );
    const maxEl      = document.getElementById( 'iri-price-max' );
    const minLabel   = document.getElementById( 'iri-price-min-label' );
    const maxLabel   = document.getElementById( 'iri-price-max-label' );
    if ( minEl && minLabel ) minLabel.textContent = fmtPrice( parseInt( minEl.value ), false, 0 );
    if ( maxEl && maxLabel ) maxLabel.textContent = fmtPrice( parseInt( maxEl.value ), true, parseInt( maxEl.max ) );
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

    updatePriceLabels();

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

  function cardHTML( l ) {
    const land = isLand( l );
    const img  = imageUrl( l );
    const url  = listingUrl( l );

    const imgBlock = img
      ? `<div class="iri-card__image"><img src="${ esc( img ) }" alt="${ esc( l.title_en ) }" loading="lazy" itemprop="image"></div>`
      : `<div class="iri-card__image iri-card__image--none"></div>`;

    // Specs row: land shows land area; non-land shows floor plan + building area + build year
    let specs = '';
    if ( land ) {
      if ( l.land_area_sqm ) specs += `<span class="iri-spec">${ numFmt( l.land_area_sqm ) } m²</span>`;
    } else {
      if ( l.floor_plan_en     ) specs += `<span class="iri-spec">${ esc( l.floor_plan_en ) }</span>`;
      if ( l.building_area_sqm ) specs += `<span class="iri-spec">${ numFmt( l.building_area_sqm ) } m²</span>`;
      if ( l.build_year        ) specs += `<span class="iri-spec">Built ${ esc( l.build_year ) }</span>`;
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

  function renderGrid( listings, append = false ) {
    const el = document.getElementById( 'iri-card-grid' );
    if ( ! el ) return;

    const visible = listings.slice( 0, currentPage * PAGE_SIZE );
    const total   = listings.length;
    const showing = visible.length;

    // Count display — "Showing 1–20 of 50 listings"
    const showingEl = document.getElementById( 'iri-showing' );
    if ( showingEl ) {
      if ( total === 0 ) {
        showingEl.textContent = 'No listings found';
      } else {
        showingEl.textContent = `Showing 1–${ showing } of ${ total } listing${ total !== 1 ? 's' : '' }`;
      }
    }

    // Load More button — hide when everything is visible
    const moreBtn = document.getElementById( 'iri-load-more' );
    if ( moreBtn ) moreBtn.style.display = showing >= total ? 'none' : '';

    if ( ! total ) {
      el.innerHTML = '<p class="iri-no-results">No listings match your filters.</p>';
      return;
    }

    el.innerHTML = visible.map( cardHTML ).join( '' );
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

  function populateFilters( listings ) {
    // Area dropdown — unique areas sorted alphabetically
    const areaEl = document.getElementById( 'iri-filter-area' );
    if ( areaEl && ! areaEl.dataset.iriPopulated ) {
      const areas = [ ...new Set( listings.map( l => l.taxonomy_property_area ).filter( Boolean ) ) ].sort();
      areas.forEach( a => {
        const o = document.createElement( 'option' );
        o.value       = a;
        o.textContent = a.charAt( 0 ).toUpperCase() + a.slice( 1 ).replace( /-/g, ' ' );
        areaEl.appendChild( o );
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
    currentPage++;
    renderGrid( currentFiltered );
    // scroll the new cards into view smoothly
    document.getElementById( 'iri-load-more' )?.scrollIntoView( { behavior: 'smooth', block: 'center' } );
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    const gridEl = document.getElementById( 'iri-card-grid' );
    const mapEl  = document.getElementById( 'iri-map' );
    if ( ! gridEl && ! mapEl ) return; // not on an archive page

    if ( gridEl ) gridEl.innerHTML = '<p class="iri-loading">Loading listings…</p>';

    try {
      allListings = await fetchAll();
    } catch ( e ) {
      console.error( 'IRI archive: failed to load listings', e );
      if ( gridEl ) gridEl.innerHTML = '<p class="iri-no-results">Could not load listings. Please try again.</p>';
      return;
    }

    currentFiltered = applyControls( allListings );
    populateFilters( allListings );
    initPriceSlider( allListings );
    renderGrid( currentFiltered );

    // Map initialises if Google Maps is already loaded; otherwise iriMapReady() handles it
    if ( typeof google !== 'undefined' ) {
      initMap();
      renderMarkers( currentFiltered );
    }

    // Bind filter and sort controls
    [ 'iri-filter-area', 'iri-filter-type', 'iri-sort' ].forEach( id => {
      document.getElementById( id )?.addEventListener( 'change', update );
    } );

    // Bind Load More button
    document.getElementById( 'iri-load-more' )?.addEventListener( 'click', loadMore );
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
