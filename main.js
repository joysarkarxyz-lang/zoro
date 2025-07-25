// Obsidian API
  const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, Modal } = require('obsidian');
  
// Default Setting
  const getDefaultGridColumns = () => {
  return window.innerWidth >= 768 ? 4 : 2;
};

const DEFAULT_SETTINGS = {
  defaultUsername: '',
  defaultLayout: 'card',
  showCoverImages: true,
  showRatings: true,
  showProgress: true,
  showGenres: false,
  showLoadingIcon: true,
  gridColumns: getDefaultGridColumns(),
  theme: '',  
  clientId: '',
  clientSecret: '',
  redirectUri: 'https://anilist.co/api/v2/oauth/pin',
  accessToken: '',
};

// Request Queue
 class RequestQueue {
  constructor(plugin) {
    this.plugin = plugin;
    this.queue = [];
    this.delay = 700; // ~85 requests/min (AniList limit: 90/min)
    this.isProcessing = false;
  } add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }
  // main.js – inside RequestQueue
showGlobalLoader() {
  if (!this.plugin?.settings?.showLoadingIcon) return; // Check setting first
  const loader = document.getElementById('zoro-global-loader');
  if (loader) loader.style.display = 'block';
}

hideGlobalLoader() {
  const loader = document.getElementById('zoro-global-loader');
  if (loader) loader.style.display = 'none'; // Always hide when done
}


  // main.js – inside RequestQueue.process()
async process() {
  if (this.isProcessing || !this.queue.length) {
    if (!this.queue.length) this.hideGlobalLoader(); // hide if queue is empty
    return;
  }
  this.isProcessing = true;
  if (this.queue.length === 1) this.showGlobalLoader(); // first item

  const { requestFn, resolve, reject } = this.queue.shift();
  try {
    const result = await requestFn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    setTimeout(() => {
      this.isProcessing = false;
      this.process(); // will hide loader if queue is now empty
    }, this.delay);
  }
}

}
// API 
class Api {
  constructor(plugin) {
    this.plugin = plugin;
    this.requestQueue = plugin.requestQueue;
    this.cache = plugin.cache;
    this.cacheTimeout = plugin.cacheTimeout;
  }

  // NEW: Create deterministic cache keys
  createCacheKey(config) {
    // Create a consistent key by sorting object keys
    const sortedConfig = {};
    Object.keys(config).sort().forEach(key => {
      sortedConfig[key] = config[key];
    });
    return JSON.stringify(sortedConfig);
  }

  async makeObsidianRequest(code, redirectUri) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.plugin.settings.clientId,
      client_secret: this.plugin.settings.clientSecret || '',
      redirect_uri: redirectUri,
      code: code
    });

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    try {
      const response = await this.requestQueue.add(() => requestUrl({
        url: 'https://anilist.co/api/v2/oauth/token',
        method: 'POST',
        headers,
        body: body.toString()
      }));

      if (!response || typeof response.json !== 'object') {
        throw new Error('Invalid response structure from AniList.');
      }

      return response.json;

    } catch (err) {
      console.error('[Zoro] Obsidian requestUrl failed:', err);
      throw new Error('Failed to authenticate with AniList via Obsidian requestUrl.');
    }
  }

  async fetchZoroData(config) {
    // FIXED: Create deterministic cache key
    const cacheKey = this.createCacheKey(config);
    
    // FIXED: Determine cache type and TTL first
    let cacheType;
    if (config.type === 'stats') {
      cacheType = 'userData';
    } else if (config.type === 'single') {
      cacheType = 'mediaData';
    } else if (config.type === 'search') {
      cacheType = 'searchResults';
    } else {
      cacheType = 'userData'; // Default for lists
    }
    
    // FIXED: Define TTL map properly
    const ttlMap = {
      userData: 30 * 60 * 1000,    // 30 min for stats/lists
      mediaData: 10 * 60 * 1000,   // 10 min for single media
      searchResults: 2 * 60 * 1000 // 2 min for search
    };
    const cacheTtl = ttlMap[cacheType] || this.plugin.cacheTimeout;

    // FIXED: Check cache FIRST - before doing any expensive work
    const cached = !config.nocache && this.plugin.getFromCache(cacheType, cacheKey, cacheTtl);
    if (cached) {
      console.log(`[Zoro] Cache HIT for ${cacheType}: ${cacheKey.substring(0, 50)}...`);
      return cached;
    }

    console.log(`[Zoro] Cache MISS for ${cacheType}: ${cacheKey.substring(0, 50)}...`);

    // Now do the expensive work only if cache miss
    let query, variables;
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      
      if (this.plugin.settings.accessToken) {
        await this.plugin.auth.ensureValidToken();
        headers['Authorization'] = `Bearer ${this.plugin.settings.accessToken}`;
      }
      
      // Build query and variables based on config type
      if (config.type === 'stats') {
        query = this.getUserStatsQuery();
        variables = { username: config.username };
      } else if (config.type === 'single') {
        query = this.getSingleMediaQuery();
        variables = {
          username: config.username,
          mediaId: parseInt(config.mediaId),
          type: config.mediaType
        };
      } else if (config.type === 'search') {
        query = this.getSearchMediaQuery(config.layout);
        variables = {
          search: config.search,
          type: config.mediaType,
          page: config.page || 1,
          perPage: config.perPage || 5,
        };
      } else {
        query = this.getMediaListQuery(config.layout);
        variables = {
          username: config.username,
          status: config.listType,
          type: config.mediaType || 'ANIME',
        };
      }
      
      // Make the GraphQL request with rate limiting
      const response = await this.requestQueue.add(() => requestUrl({
        url: 'https://graphql.anilist.co',
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables })
      }));
      
      const result = response.json;
      if (!result) throw new Error('Empty response from AniList.');
      
      if (result.errors && result.errors.length > 0) {
        const firstError = result.errors[0];
        const isPrivate = firstError.message?.includes('Private') || firstError.message?.includes('permission');

        if (isPrivate) {
          if (this.plugin.settings.accessToken) {
            throw new Error('🚫 List is private and this token has no permission.');
          } else {
            throw new Error('🔒 List is private. Please authenticate to access it.');
          }
        }
        throw new Error(firstError.message || 'AniList returned an unknown error.');
      }
      
      if (!result.data) {
        throw new Error('AniList returned no data.');
      }
      
      // FIXED: Save to cache with logging
      this.plugin.setToCache(cacheType, cacheKey, result.data);
      console.log(`[Zoro] Cached data for ${cacheType}: ${cacheKey.substring(0, 50)}...`);
      
      return result.data;

    } catch (error) {
      console.error('[Zoro] fetchZoroData() failed:', error);
      throw error;
    }
  }

  async updateMediaListEntry(mediaId, updates) {
    try {
      if (!this.plugin.settings.accessToken || !(await this.plugin.auth.ensureValidToken())) {
        throw new Error('❌ Authentication required to update entries.');
      }

      const mutation = `
        mutation ($mediaId: Int, $status: MediaListStatus, $score: Float, $progress: Int) {
          SaveMediaListEntry(mediaId: $mediaId, status: $status, score: $score, progress: $progress) {
            id
            status
            score
            progress
          }
        }
      `;
      
      const variables = {
        mediaId,
        ...(updates.status !== undefined && { status: updates.status }),
        ...(updates.score !== undefined && updates.score !== null && { score: updates.score }),
        ...(updates.progress !== undefined && { progress: updates.progress }),
      };
      
      const response = await this.requestQueue.add(() => requestUrl({
        url: 'https://graphql.anilist.co',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.plugin.settings.accessToken}`
        },
        body: JSON.stringify({ query: mutation, variables })
      }));

      const result = response.json;

      if (!result || result.errors?.length > 0) {
        const message = result.errors?.[0]?.message || 'Unknown mutation error';
        throw new Error(`AniList update error: ${message}`);
      }
      
      // FIXED: Clear cache after update
      this.plugin.clearCacheForMedia(mediaId);
      
      return result.data.SaveMediaListEntry;

    } catch (error) {
      console.error('[Zoro] updateMediaListEntry failed:', error);
      throw new Error(`❌ Failed to update entry: ${error.message}`);
    }
  }

  async checkIfMediaInList(mediaId, mediaType) {
    if (!this.plugin.settings.accessToken) return false;
    
    try {
      const config = {
        type: 'single',
        mediaType: mediaType,
        mediaId: parseInt(mediaId)
      };
      
      const response = await this.fetchZoroData(config);
      return response.MediaList !== null;
    } catch (error) {
      console.warn('Error checking media list status:', error);
      return false;
    }
  }

  getMediaListQuery(layout = 'card') {
    const baseFields = `
      id
      status
      score
      progress
    `;

    const mediaFields = {
      compact: `
        id
        title {
          romaji
        }
        coverImage {
          medium
        }
      `,
      card: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        format
        averageScore
        status
        genres
        episodes
        chapters
      `,
      full: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        episodes
        chapters
        genres
        format
        averageScore
        status
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
      `
    };

    const fields = mediaFields[layout] || mediaFields.card;

    return `
      query ($username: String, $status: MediaListStatus, $type: MediaType) {
        MediaListCollection(userName: $username, status: $status, type: $type) {
          lists {
            entries {
              ${baseFields}
              media {
                ${fields}
              }
            }
          }
        }
      }
    `;
  }

  getSingleMediaQuery(layout = 'card') {
    const baseFields = `
      id
      status
      score
      progress
    `;

    const mediaFields = {
      compact: `
        id
        title {
          romaji
        }
        coverImage {
          medium
        }
      `,
      card: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        format
        averageScore
        status
        genres
        episodes
        chapters
      `,
      full: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        episodes
        chapters
        genres
        format
        averageScore
        status
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
      `
    };

    const selectedMediaFields = mediaFields[layout] || mediaFields.card;

    return `
      query ($username: String, $mediaId: Int, $type: MediaType) {
        MediaList(userName: $username, mediaId: $mediaId, type: $type) {
          ${baseFields}
          media {
            ${selectedMediaFields}
          }
        }
      }
    `;
  }

  getUserStatsQuery({ mediaType = 'ANIME', layout = 'card', useViewer = false } = {}) {
    const typeKey = mediaType.toLowerCase(); // 'anime' or 'manga'

    const statFields = {
      compact: `
        count
        meanScore
      `,
      card: `
        count
        meanScore
        standardDeviation
      `,
      full: `
        count
        meanScore
        standardDeviation
        episodesWatched
        minutesWatched
        chaptersRead
        volumesRead
      `
    };

    const selectedFields = statFields[layout] || statFields.card;
    const viewerPrefix = useViewer ? 'Viewer' : `User(name: $username)`;

    return `
      query ($username: String) {
        ${viewerPrefix} {
          id
          name
          avatar {
            large
            medium
          }
          statistics {
            ${typeKey} {
              ${selectedFields}
            }
          }
        }
      }
    `;
  }

  getSearchMediaQuery(layout = 'card') {
    const mediaFields = {
      compact: `
        id
        title {
          romaji
        }
        coverImage {
          medium
        }
      `,
      card: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        format
        averageScore
        status
        genres
        episodes
        chapters
      `,
      full: `
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          large
          medium
        }
        episodes
        chapters
        genres
        format
        averageScore
        status
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
      `
    };

    const fields = mediaFields[layout] || mediaFields.card;

    return `
      query ($search: String, $type: MediaType, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          media(search: $search, type: $type) {
            ${fields}
          }
        }
      }
    `;
  }

  getZoroUrl(mediaId, mediaType = 'ANIME') {
    if (!mediaId || typeof mediaId !== 'number') {
      throw new Error(`Invalid mediaId: ${mediaId}`);
    }

    const type = String(mediaType).toUpperCase();
    const validTypes = ['ANIME', 'MANGA'];
    const urlType = validTypes.includes(type) ? type.toLowerCase() : 'anime'; // fallback

    return `https://anilist.co/${urlType}/${mediaId}`;
  }
  
// In your API class
getDetailedMediaQuery() {
  return `
    query ($id: Int) {
      Media(id: $id) {
        id
        title {
          romaji
          english
          native
        }
        description
        format
        status
        episodes
        chapters
        volumes
        duration
        season
        seasonYear
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
        averageScore
        meanScore
        popularity
        favourites
        trending
        source
        isAdult
        siteUrl
        genres
        synonyms
        hashtag
        trailer {
          id
          site
        }
        tags(perPage: 20) {
          name
          rank
          isMediaSpoiler
        }
        characters(page: 1, perPage: 10, sort: ROLE) {
          edges {
            role
            node {
              name {
                full
              }
              image {
                medium
              }
            }
          }
        }
        staff(page: 1, perPage: 12) {
          edges {
            role
            node {
              name {
                full
              }
            }
          }
        }
        studios {
          edges {
            node {
              name
            }
          }
        }
        relations {
          edges {
            relationType
            node {
              title {
                romaji
                english
              }
              format
            }
          }
        }
        externalLinks {
          site
          url
        }
      }
    }
  `;
}

// Add this method if it doesn't exist
async getDetailedMedia(mediaId) {
  const query = this.getDetailedMediaQuery();
  const variables = { id: mediaId };
  return await this.request(query, variables);
}
}
// Plugin
class ZoroPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.globalListeners = [];

    // Initialize separate caches
    this.cache = {
      userData: new Map(),
      mediaData: new Map(),
      searchResults: new Map() 
    };
    this.requestQueue = new RequestQueue();
    this.cacheTimeout = 4 * 60 * 1000; // 4 min default
    
    // FIXED: More frequent pruning to handle shorter TTLs
    this.pruneInterval = setInterval(() => this.pruneCache(), 60 * 1000); // Every minute
    this.requestQueue = new RequestQueue(this);
    this.api = new Api(this);
    this.auth = new Authentication(this);
    this.theme = new Theme(this);
    this.processor = new Processor(this);
    this.edit = new Edit(this);
    this.moreDetailsPanel = new MoreDetailsPanel(this);
    this.export = new Export(this);
    this.sample = new Sample(this);
    this.prompt = new Prompt(this);
  }

  getZoroUrl(mediaId, mediaType = 'ANIME') {
    return this.api.getZoroUrl(mediaId, mediaType);
  }

  // FIXED: Improved pruning with better logging
  pruneCache() {
    const now = Date.now();
    let totalPruned = 0;
    
    // Define TTLs for each cache type
    const ttlMap = {
      userData: 30 * 60 * 1000,    // 30 min
      mediaData: 10 * 60 * 1000,   // 10 min
      searchResults: 2 * 60 * 1000 // 2 min
    };
    
    for (const [cacheType, map] of Object.entries(this.cache)) {
      const ttl = ttlMap[cacheType] || this.cacheTimeout;
      let pruned = 0;
      
      for (const [key, entry] of map.entries()) {
        if (now - entry.timestamp > ttl) {
          map.delete(key);
          pruned++;
        }
      }
      
      if (pruned > 0) {
        console.log(`[Zoro] Pruned ${pruned} expired entries from ${cacheType} cache`);
        totalPruned += pruned;
      }
    }
    
    if (totalPruned > 0) {
      console.log(`[Zoro] Total cache entries pruned: ${totalPruned}`);
    }
  }

  // FIXED: Better cache retrieval with logging
  getFromCache(type, key, customTtl = null) {
    const cacheMap = this.cache[type];
    if (!cacheMap) {
      console.warn(`[Zoro] Invalid cache type: ${type}`);
      return null;
    }
    
    const entry = cacheMap.get(key);
    if (!entry) {
      return null;
    }
    
    // Check TTL
    const ttl = customTtl ?? this.cacheTimeout;
    const age = Date.now() - entry.timestamp;
    
    if (age > ttl) {
      cacheMap.delete(key);
      console.log(`[Zoro] Expired cache entry removed from ${type}: age=${age}ms, ttl=${ttl}ms`);
      return null;
    }
    
    return entry.value;
  }

  // FIXED: Better cache setting with logging
  setToCache(type, key, value) {
    const cacheMap = this.cache[type];
    if (!cacheMap) {
      console.warn(`[Zoro] Invalid cache type: ${type}`);
      return;
    }
    
    cacheMap.set(key, {
      value,
      timestamp: Date.now()
    });
    
    console.log(`[Zoro] Cached data in ${type}: ${cacheMap.size} total entries`);
  }

  // FIXED: Improved cache clearing with better error handling
  clearCacheForMedia(mediaId) {
    const id = parseInt(mediaId, 10);
    if (!id) {
      console.warn(`[Zoro] Invalid mediaId for cache clearing: ${mediaId}`);
      return;
    }

    let totalCleared = 0;

    const prune = (map, cacheType, exactKeys) => {
      let cleared = 0;
      for (const key of Array.from(map.keys())) { // Create array to avoid modification during iteration
        try {
          const parsed = JSON.parse(key);
          if (exactKeys.some(k => parsed[k] === id)) {
            map.delete(key);
            cleared++;
            console.log(`[Zoro] Cleared ${cacheType} cache key: ${key.substring(0, 80)}...`);
          }
        } catch (e) {
          // Skip non-JSON keys silently
          continue;
        }
      }
      return cleared;
    };

    // Clear from all cache types
    totalCleared += prune(this.cache.mediaData, 'mediaData', ['mediaId']);
    totalCleared += prune(this.cache.userData, 'userData', ['mediaId']);
    totalCleared += prune(this.cache.searchResults, 'searchResults', ['mediaId']);

    console.log(`[Zoro] Cleared ${totalCleared} cache entries for media ${id}`);
    
    // Also clear any list caches that might contain this media
    this.clearListCaches();
  }

// ✅ Removes just the affected entry, keeps everything else
clearSingleEntryCache(mediaId, username, mediaType = 'ANIME') {
  const id = parseInt(mediaId, 10);
  if (!id || !username) return;

  // Key pattern used by Api.createCacheKey
  const listKey = JSON.stringify({
    username,
    type: 'list',
    listType: 'CURRENT',   // any list type is inside the same response
    mediaType
  });

  // Remove the *whole list* only for this user/type combo
  this.cache.userData.delete(listKey);

  // Remove the single-media cache for this item
  const singleKey = JSON.stringify({
    username,
    type: 'single',
    mediaId: id,
    mediaType
  });
  this.cache.mediaData.delete(singleKey);

  console.log(`[Zoro] Invalidated cache for media ${id} (user: ${username})`);
}

  // NEW: Clear list caches (useful after updates)
  clearListCaches() {
    const beforeCount = this.cache.userData.size;
    this.cache.userData.clear();
    console.log(`[Zoro] Cleared ${beforeCount} user data cache entries`);
  }

  // FIXED: Better cache persistence
  async saveCacheToStorage() {
    try {
      const cacheData = {};
      let totalEntries = 0;
      
      for (const [type, map] of Object.entries(this.cache)) {
        const entries = Array.from(map.entries());
        cacheData[type] = entries;
        totalEntries += entries.length;
      }
      
      localStorage.setItem('zoro-cache', JSON.stringify(cacheData));
      console.log(`[Zoro] Saved ${totalEntries} cache entries to storage`);
    } catch (e) {
      console.warn('[Zoro] Failed to save cache to storage:', e);
    }
  }

  // FIXED: Better cache loading with validation
  async loadCacheFromStorage() {
    try {
      const saved = localStorage.getItem('zoro-cache');
      if (!saved) {
        console.log('[Zoro] No cached data found in storage');
        return;
      }
      
      const cacheData = JSON.parse(saved);
      let loadedCount = 0;
      let expiredCount = 0;
      
      // Define TTLs for validation
      const ttlMap = {
        userData: 30 * 60 * 1000,
        mediaData: 10 * 60 * 1000,
        searchResults: 2 * 60 * 1000
      };
      
      for (const [type, entries] of Object.entries(cacheData)) {
        if (this.cache[type] && Array.isArray(entries)) {
          const ttl = ttlMap[type] || this.cacheTimeout;
          
          entries.forEach(([key, value]) => {
            if (value && typeof value.timestamp === 'number') {
              const age = Date.now() - value.timestamp;
              if (age < ttl) {
                this.cache[type].set(key, value);
                loadedCount++;
              } else {
                expiredCount++;
              }
            }
          });
        }
      }
      
      console.log(`[Zoro] Loaded ${loadedCount} cached items from storage (${expiredCount} expired)`);
    } catch (e) {
      console.warn('[Zoro] Failed to load cache from storage:', e);
      // Clear corrupted storage
      localStorage.removeItem('zoro-cache');
    }
  }

  // NEW: Debug method to inspect cache
  debugCache() {
    console.log('=== ZORO CACHE DEBUG ===');
    let totalEntries = 0;
    
    for (const [type, map] of Object.entries(this.cache)) {
      console.log(`\n${type.toUpperCase()} CACHE: ${map.size} entries`);
      totalEntries += map.size;
      
      if (map.size > 0) {
        let count = 0;
        for (const [key, entry] of map.entries()) {
          if (count < 3) { // Show first 3 entries
            const age = Date.now() - entry.timestamp;
            const keyPreview = key.length > 100 ? key.substring(0, 100) + '...' : key;
            console.log(`  [${count + 1}] Age: ${Math.round(age/1000)}s | Key: ${keyPreview}`);
          }
          count++;
        }
        if (map.size > 3) {
          console.log(`  ... and ${map.size - 3} more entries`);
        }
      }
    }
    
    console.log(`\nTOTAL CACHE ENTRIES: ${totalEntries}`);
    console.log('========================');
  }

  // Onload with better cache initialization
  async onload() {
    console.log('[Zoro] Plugin loading...');
    this.render = new Render(this);
    
    try {
      await this.loadSettings();
      console.log('[Zoro] Settings loaded.');
    } catch (err) {
      console.error('[Zoro] Failed to load settings:', err);
    }
    
    // Load cache after settings
    await this.loadCacheFromStorage();
    
    try {
      this.injectCSS();
      console.log('[Zoro] CSS injected.');
    } catch (err) {
      console.error('[Zoro] Failed to inject CSS:', err);
    }
    
    await this.theme.applyTheme(this.settings.theme);

    // Processors
    this.registerMarkdownCodeBlockProcessor('zoro', this.processor.processZoroCodeBlock.bind(this.processor));
    this.registerMarkdownCodeBlockProcessor('zoro-search', this.processor.processZoroSearchCodeBlock.bind(this.processor));
    this.registerMarkdownPostProcessor(this.processor.processInlineLinks.bind(this.processor));
    
    this.addSettingTab(new ZoroSettingTab(this.app, this));
    console.log('[Zoro] Plugin loaded successfully.');
  }

  // Rest of your existing methods
  validateSettings(settings) {
  return {
    defaultUsername: typeof settings?.defaultUsername === 'string' ? settings.defaultUsername : '',
    defaultLayout: ['card', 'list'].includes(settings?.defaultLayout) ? settings.defaultLayout : 'card',
    gridColumns: Number.isInteger(settings?.gridColumns) ? settings.gridColumns : getDefaultGridColumns(),
    theme: typeof settings?.theme === 'string' ? settings.theme : '',
    showCoverImages: !!settings?.showCoverImages,
    showRatings: !!settings?.showRatings,
    showProgress: !!settings?.showProgress,
    showGenres: !!settings?.showGenres,
    showLoadingIcon: typeof settings?.showLoadingIcon === 'boolean' ? settings.showLoadingIcon : true, // Add this line
    clientId: typeof settings?.clientId === 'string' ? settings.clientId : '',
    clientSecret: typeof settings?.clientSecret === 'string' ? settings.clientSecret : '',
    redirectUri: typeof settings?.redirectUri === 'string' ? settings.redirectUri : DEFAULT_SETTINGS.redirectUri,
    accessToken: typeof settings?.accessToken === 'string' ? settings.accessToken : '',
  };
}
  

  async saveSettings() {
    try {
      const validSettings = this.validateSettings(this.settings);
      await this.saveData(validSettings);
      console.log('[Zoro] Settings saved successfully.');
    } catch (err) {
      console.error('[Zoro] Failed to save settings:', err);
      new Notice('⚠️ Failed to save settings. See console for details.');
    }
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings = this.validateSettings(merged);
    if (!this.settings.clientSecret) {
      const secret = await this.promptForSecret("Paste your client secret:");
      this.settings.clientSecret = secret.trim();
      await this.saveData(this.settings);
    }
  }

  addGlobalListener(el, type, fn) {
    el.addEventListener(type, fn);
    this.globalListeners.push({ el, type, fn });
  }

  removeAllGlobalListeners() {
    this.globalListeners.forEach(({ el, type, fn }) => {
      el.removeEventListener(type, fn);
    });
    this.globalListeners.length = 0;
  }

  handleEditClick(e, entry, statusEl) {
    e.preventDefault();
    e.stopPropagation();

    this.edit.createEditModal(
      entry,
      async updates => {
        try {
          await this.api.updateMediaListEntry(entry.media.id, updates);
          new Notice('✅ Updated!');
          
         this.plugin.clearSingleEntryCache(
  entry.media.id,
  this.plugin.settings.defaultUsername || config.username,
  config.mediaType
);


          const parent = statusEl.closest('.zoro-container');
          if (parent) {
            const block = parent.closest('.markdown-rendered')?.querySelector('code');
            if (block) this.processZoroCodeBlock(block.textContent, parent, {});
          }
        } catch (err) {
          new Notice(`❌ Update failed: ${err.message}`);
        }
      },
      () => {
        // Cancel callback - do nothing
      }
    );
  }

  injectCSS() {
    const styleId = 'zoro-plugin-styles';
    const existingStyle = document.getElementById(styleId);
    if (existingStyle) existingStyle.remove();
    
    const css = `
      .zoro-container { /* styles */ }
      /* add all necessary styles here */
    `;
    
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);

    this.globalLoader = document.createElement('div');
    this.globalLoader.id = 'zoro-global-loader';
    this.globalLoader.textContent = '⏳';
    this.globalLoader.style.cssText = 'position:fixed;bottom:10px;left:10px;font-size:16px;z-index:9999;display:none;';
    document.body.appendChild(this.globalLoader);
  }

  handleAuthMessage(event) {
    if (event.origin !== 'https://anilist.co') return;
    this.exchangeCodeForToken(event.data.code);
  }

  renderError(el, message, context = '', onRetry = null) {
    el.empty?.();
    el.classList.add('zoro-error-container');

    const wrapper = el.createDiv({ cls: 'zoro-error-box' });
    wrapper.createEl('strong', { text: `❌ ${context || 'Something went wrong'}` });
    wrapper.createEl('pre', { text: message });

    if (onRetry) {
      wrapper.createEl('button', { text: '🔄 Retry', cls: 'zoro-retry-btn' })
            .onclick = () => {
              el.empty();
              onRetry();
            };
    } else {
      wrapper.createEl('button', { text: 'Reload Note', cls: 'zoro-retry-btn' })
            .onclick = () => this.app.workspace.activeLeaf.rebuildView();
    }
  }

  // FIXED: Better cleanup on unload
  onunload() {
    console.log('[Zoro] Unloading plugin...');

    // Save cache before unloading
    this.saveCacheToStorage();

    // Clean up intervals
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    // Clear caches
    this.cache.userData.clear();
    this.cache.mediaData.clear();
    this.cache.searchResults.clear();

    // Remove theme and styles
    this.theme.removeTheme();
  const styleId = 'zoro-plugin-styles';
  const existingStyle = document.getElementById(styleId);
  if (existingStyle) {
    existingStyle.remove();
    console.log(`Removed style element with ID: ${styleId}`);
  }
      
      const loader = document.getElementById('zoro-global-loader');
  if (loader) loader.remove();
      
  }

}

// Processor 
class Processor {
  constructor(plugin) {
    this.plugin = plugin;
  }

  // Process Zoro Code Block
 // Replace the top of processZoroCodeBlock method
async processZoroCodeBlock(source, el, ctx) {
  try {
    // Show appropriate skeleton immediately
    const config = this.parseCodeBlockConfig(source) || {};
    let skeleton;
    
    if (config.type === 'stats') {
      skeleton = this.plugin.render.createStatsSkeleton();
    } else if (config.type === 'single') {
      skeleton = this.plugin.render.createListSkeleton(1);
    } else {
      skeleton = this.plugin.render.createListSkeleton();
    }
    
    el.empty();
    el.appendChild(skeleton);

    // Handle authenticated user if needed
    if (config.useAuthenticatedUser) {
      const authUsername = await this.plugin.auth.getAuthenticatedUsername();
      if (!authUsername) {
        throw new Error('❌ Could not retrieve authenticated username...');
      }
      config.username = authUsername;
    }

    const doFetch = async () => {
      try {
        const data = await this.plugin.api.fetchZoroData(config);
        
        // Remove skeleton and render real data
        el.empty();
        
        // Render based on config type
        if (config.type === 'stats') {
          this.plugin.render.renderUserStats(el, data.User);
        } else if (config.type === 'single') {
          this.plugin.render.renderSingleMedia(el, data.MediaList, config);
        } else {
          const entries = data.MediaListCollection.lists.flatMap(list => list.entries);
          this.plugin.render.renderMediaList(el, entries, config);
        }
        
      } catch (err) {
        el.empty(); // Clear any existing content
        this.plugin.renderError(el, err.message,
          'Failed to load list',
          doFetch  // ← retry action
        );
      }
    };
    
    await doFetch();

  } catch (error) {
    el.empty(); // Clear skeleton on error
    console.error('[Zoro] Code block processing error:', error);
    this.plugin.renderError(
      el,
      error.message || 'Unknown error occurred.',
      'Code block',
      () => this.processZoroCodeBlock(source, el, ctx)
    );
  }
}

// Process Zoro Search Code Block
async processZoroSearchCodeBlock(source, el, ctx) {
  try {
    const config = this.parseSearchCodeBlockConfig(source);

    if (this.plugin.settings.debugMode) {
      console.log('[Zoro] Search block config:', config);
    }

    // Show loading placeholder
    el.createEl('div', { text: '🔍 Searching Zoro...', cls: 'zoro-loading-placeholder' });
    
    const doSearch = async () => {
      try {
        await this.plugin.render.renderSearchInterface(el, config);
      } catch (err) {
        el.empty(); // Clear loading placeholder
        this.plugin.renderError(el, err.message,
          'Search failed',
          doSearch
        );
      }
    };
    
    await doSearch();
  } catch (error) {
    console.error('[Zoro] Search block processing error:', error);
    el.empty(); // Clear any existing content
    this.plugin.renderError(
      el,
      error.message || 'Failed to process Zoro search block.',
      'Search block',
      () => this.processZoroSearchCodeBlock(source, el, ctx)
    );
  }
}

// Process Inline Links
async processInlineLinks(el, ctx) {
  const inlineLinks = el.querySelectorAll('a[href^="zoro:"]');

  for (const link of inlineLinks) {
    const href = link.getAttribute('href');
    
    // Optional: Show loading shimmer while data loads
    const placeholder = document.createElement('span');
    placeholder.textContent = '🔄 Loading Zoro...';
    link.replaceWith(placeholder);

    try {
      const config = this.parseInlineLink(href);
      const data = await this.plugin.api.fetchZoroData(config);

      const container = document.createElement('span');
      container.className = 'zoro-inline-container';
      
      if (config.type === 'stats') {
        this.plugin.render.renderUserStats(container, data.User);
      } else if (config.type === 'single') {
        this.plugin.render.renderSingleMedia(container, data.MediaList, config);
      } else {
        const entries = data.MediaListCollection.lists.flatMap(list => list.entries);
        this.plugin.render.renderMediaList(container, entries, config);
      }

      placeholder.replaceWith(container);

      // ✅ Cleanup if the block is removed (important for re-render safety)
      ctx.addChild({
        unload: () => {
          container.remove();
        }
      });

    } catch (error) {
      console.warn(`[Zoro] Inline link failed for ${href}:`, error);

      const container = document.createElement('span');
      container.className = 'zoro-inline-container';

      const retry = () => this.processInlineLinks(el, ctx); // re-scan
      this.plugin.renderError(container, error.message, 'Inline link', retry);

      placeholder.replaceWith(container);
    }
  }
}
  // Parse Code Block Config
  parseCodeBlockConfig(source) {
    const config = {};
    const lines = source.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const [key, value] = line.split(':').map(s => s.trim());
      if (key && value) {
        config[key] = value;
      }
    }
    
    // Use authenticated user if no username provided and no default username
    if (!config.username) {
      if (this.plugin.settings.defaultUsername) {
        config.username = this.plugin.settings.defaultUsername;
      } else if (this.plugin.settings.accessToken) {
        config.useAuthenticatedUser = true;
      } else {
        throw new Error('Username is required. Please set a default username in plugin settings, authenticate, or specify one in the code block.');
      }
    }
    
    config.listType = config.listType || 'CURRENT';
    config.layout = config.layout || this.plugin.settings.defaultLayout;
    config.mediaType = config.mediaType || 'ANIME';
    
    return config;
  }

  // Parse Search Code Block Config
  parseSearchCodeBlockConfig(source) {
    const config = { type: 'search' };
    const lines = source.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const [key, value] = line.split(':').map(s => s.trim());
      if (key && value) {
        config[key] = value;
      }
    }
    
    config.layout = config.layout || this.plugin.settings.defaultLayout || 'card';
    
    // Default to ANIME if no mediaType specified
    config.mediaType = config.mediaType || 'ANIME';
    config.layout = config.layout || this.plugin.settings.defaultLayout;
    
    return config;
  }

  // Parse Inline Link
  parseInlineLink(href) {
    const [base, hash] = href.replace('zoro:', '').split('#');

    const parts = base.split('/');
    let username, pathParts;

    if (parts[0] === '') {
      if (!this.plugin.settings.defaultUsername) {
        throw new Error('⚠️ Default username not set. Configure it in plugin settings.');
      }
      username = this.plugin.settings.defaultUsername;
      pathParts = parts.slice(1);
    } else {
      if (parts.length < 2) {
        throw new Error('❌ Invalid Zoro inline link format.');
      }
      username = parts[0];
      pathParts = parts.slice(1);
    }

    const config = {
      username: username,
      layout: 'card', // Default layout
      type: 'list'     // Default to media list
    };

    const main = pathParts[0];
    const second = pathParts[1];

    if (main === 'stats') {
      config.type = 'stats';
    } else if (main === 'anime' || main === 'manga') {
      config.type = 'single';
      config.mediaType = main.toUpperCase();
      if (!second || isNaN(parseInt(second))) {
        throw new Error('⚠️ Invalid media ID for anime/manga inline link.');
      }
      config.mediaId = parseInt(second);
    } else {
      config.listType = main.toUpperCase();
    }

    // Optional layout modifiers from hash
    if (hash) {
      const hashParts = hash.split(',');
      for (const mod of hashParts) {
        if (mod === 'compact' || mod === 'card' || mod === 'minimal' || mod === 'full') {
          config.layout = mod;
        }
        if (mod === 'nocache') {
          config.nocache = true;
        }
      }
    }

    return config;
  }
}

// Render
class Render {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /* ----------  SEARCH  ---------- */
  renderSearchInterface(el, config) {
    el.empty();
    el.className = 'zoro-search-container';

    const searchDiv = el.createDiv({ cls: 'zoro-search-input-container' });
    const input = searchDiv.createEl('input', { type: 'text', cls: 'zoro-search-input' });
    input.placeholder = config.mediaType === 'ANIME' ? 'Search anime…' : 'Search manga…';

    const resultsDiv = el.createDiv({ cls: 'zoro-search-results' });
    let timeout;
    // In renderSearchInterface - replace the doSearch function
const doSearch = async () => {
  const term = input.value.trim();
  if (term.length < 3) {
    resultsDiv.innerHTML = '<div class="zoro-search-message">Type at least 3 characters…</div>';
    return;
  }
  
  try {
    // Show skeleton during search
    resultsDiv.innerHTML = '';
    resultsDiv.appendChild(this.createListSkeleton(5));
    
    const data = await this.plugin.api.fetchZoroData({ ...config, search: term, page: 1, perPage: 5 });
    
    // Remove skeleton and show results
    resultsDiv.innerHTML = '';
    this.renderSearchResults(resultsDiv, data.Page.media, config);
  } catch (e) {
    this.plugin.renderError(resultsDiv, e.message);
  }
};

    input.addEventListener('input', () => { clearTimeout(timeout); timeout = setTimeout(doSearch, 300); });
    input.addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });
  }

// In renderMediaList() - replace the grid creation part
renderMediaList(el, entries, config) {
  el.empty();
  el.className = 'zoro-container';
  
  if (config.layout === 'table') {
    this.renderTableLayout(el, entries, config);
    return;
  }

  const grid = el.createDiv({ cls: 'zoro-cards-grid' });
  grid.style.setProperty('--zoro-grid-columns', this.plugin.settings.gridColumns);
  
  // Batch all cards into a fragment
  const fragment = document.createDocumentFragment();
  entries.forEach(entry => {
    fragment.appendChild(this.createMediaCard(entry, config));
  });
  
  grid.appendChild(fragment); // Single DOM operation
}

// In renderSearchResults() - replace the grid creation part
renderSearchResults(el, media, config) {
  el.empty();
  if (media.length === 0) {
    el.innerHTML = '<div class="zoro-search-message">No results found.</div>';
    return;
  }

  const grid = el.createDiv({ cls: 'zoro-cards-grid' });
  grid.style.setProperty('--zoro-grid-columns', this.plugin.settings.gridColumns);
  
  // Batch all cards into a fragment
  const fragment = document.createDocumentFragment();
  media.forEach(item => {
    fragment.appendChild(this.createMediaCard(item, config, { isSearch: true }));
  });
  
  grid.appendChild(fragment); // Single DOM operation
}


renderTableLayout(el, entries, config) {
  const table = el.createEl('table', { cls: 'zoro-table' });
  const headers = ['Title', 'Format', 'Status'];
  if (this.plugin.settings.showProgress) headers.push('Progress');
  if (this.plugin.settings.showRatings) headers.push('Score');
  if (this.plugin.settings.showGenres) headers.push('Genres');

  table.createTHead().createEl('tr', null, tr =>
    headers.forEach(h => tr.createEl('th', { text: h }))
  );

  const tbody = table.createTBody();
  const fragment = document.createDocumentFragment();   // 🎯 batch container

  entries.forEach(entry => {
    const m = entry.media;
    const tr = fragment.createEl('tr');                 // build off-fragment
    tr.createEl('td', null, td =>
      td.createEl('a', {
        text: m.title.english || m.title.romaji,
        href: this.plugin.getZoroUrl(m.id, config.mediaType),
        cls: 'zoro-title-link',
        target: '_blank'
      })
    );
    tr.createEl('td', { text: m.format || '-' });
    tr.createEl('td', null, td => {
      const s = td.createEl('span', {
        text: entry.status,
        cls: `status-badge status-${entry.status.toLowerCase()} clickable-status`
      });
      s.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.plugin.settings.accessToken) {
          this.plugin.prompt.createAuthenticationPrompt();
          return;
        }
        this.plugin.handleEditClick(e, entry, s);
      };
    });
    if (this.plugin.settings.showProgress)
      tr.createEl('td', {
        text: `${entry.progress ?? 0}/${m.episodes ?? m.chapters ?? '?'}`
      });
    if (this.plugin.settings.showRatings)
      tr.createEl('td', { text: entry.score != null ? `★ ${entry.score}` : '-' });
    if (this.plugin.settings.showGenres)
      tr.createEl('td', {
        text: (m.genres || []).slice(0, 3).join(', ') || '-'
      });
  });

  tbody.appendChild(fragment);  // ⚡ single DOM write
}

  

  /* ----------  SINGLE MEDIA  ---------- */
  renderSingleMedia(el, mediaList, config) {
    const m = mediaList.media;
    el.empty(); el.className = 'zoro-container';
    const card = el.createDiv({ cls: 'zoro-single-card' });

    if (this.plugin.settings.showCoverImages) {
      card.createEl('img', { cls: 'media-cover', attr: { src: m.coverImage.large, alt: m.title.english || m.title.romaji } });
    }
    const info = card.createDiv({ cls: 'media-info' });
    info.createEl('h3', null, h => {
      h.createEl('a', { text: m.title.english || m.title.romaji, href: this.plugin.getZoroUrl(m.id, config.mediaType), cls: 'zoro-title-link', target: '_blank' });
    });

    const details = info.createDiv({ cls: 'media-details' });
    if (m.format) details.createEl('span', { text: m.format, cls: 'format-badge' });
    details.createEl('span', { text: mediaList.status, cls: `status-badge status-${mediaList.status.toLowerCase()}` });
    const status = details.lastChild; // the span we just created
    status.classList.add('clickable-status');
    status.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      if (!this.plugin.settings.accessToken) {
        this.plugin.prompt.createAuthenticationPrompt();
        return;
      }
      this.plugin.handleEditClick(e, mediaList, status);
    };

    if (this.plugin.settings.showProgress) details.createEl('span', { text: `${mediaList.progress}/${m.episodes || m.chapters || '?'}`, cls: 'progress' });
    if (this.plugin.settings.showRatings && mediaList.score != null) details.createEl('span', { text: `★ ${mediaList.score}`, cls: 'score' });

    if (this.plugin.settings.showGenres && m.genres?.length) {
      const g = info.createDiv({ cls: 'genres' });
      m.genres.slice(0, 3).forEach(genre => g.createEl('span', { text: genre, cls: 'genre-tag' }));
    }
  }

  /* ----------  USER STATS  ---------- */
  renderUserStats(el, user) {
    el.empty(); el.className = 'zoro-container';
    if (!user?.statistics) { el.createDiv({ cls: 'zoro-error-box', text: 'Stats unavailable' }); return; }

    const container = el.createDiv({ cls: 'zoro-user-stats' });
    container.createDiv({ cls: 'zoro-user-header' }, div => {
      div.createEl('img', { cls: 'zoro-user-avatar', attr: { src: user.avatar?.medium || '', alt: user.name } });
      div.createEl('h3', { text: user.name });
    });

    const grid = container.createDiv({ cls: 'zoro-stats-grid' });
    ['anime', 'manga'].forEach(type => {
      const stats = user.statistics[type];
      if (!stats) return;
      const sec = grid.createDiv({ cls: 'zoro-stat-section' });
      sec.createEl('h4', { text: type.charAt(0).toUpperCase() + type.slice(1) });
      ['count', 'meanScore', 'episodesWatched', 'chaptersRead'].forEach(k => {
        if (stats[k] != null) sec.createDiv({ cls: 'zoro-stat-item', text: `${k}: ${stats[k].toLocaleString?.() ?? stats[k]}` });
      });
    });
  }

// Add to Render class for progressive rendering
  renderMediaListChunked(el, entries, config, chunkSize = 20) {
  el.empty();
  el.className = 'zoro-container';
  
  const grid = el.createDiv({ cls: 'zoro-cards-grid' });
  grid.style.setProperty('--zoro-grid-columns', this.plugin.settings.gridColumns);
  
  let index = 0;
  
  const renderChunk = () => {
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + chunkSize, entries.length);
    
    for (; index < end; index++) {
      fragment.appendChild(this.createMediaCard(entries[index], config));
    }
    
    grid.appendChild(fragment);
    
    if (index < entries.length) {
      // Use requestAnimationFrame for smooth chunking
      requestAnimationFrame(renderChunk);
    }
  };
  
  renderChunk();
}

// Add these methods to Render class
createListSkeleton(count = 6) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'zoro-card zoro-skeleton';
    skeleton.innerHTML = `
      <div class="skeleton-cover"></div>
      <div class="media-info">
        <div class="skeleton-title"></div>
        <div class="skeleton-details">
          <span class="skeleton-badge"></span>
          <span class="skeleton-badge"></span>
        </div>
      </div>
    `;
    fragment.appendChild(skeleton);
  }
  return fragment;
}

createStatsSkeleton() {
  const container = document.createElement('div');
  container.className = 'zoro-container zoro-stats-skeleton';
  container.innerHTML = `
    <div class="zoro-user-stats">
      <div class="zoro-user-header">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-title"></div>
      </div>
      <div class="zoro-stats-grid">
        <div class="skeleton-stat-section"></div>
        <div class="skeleton-stat-section"></div>
      </div>
    </div>
  `;
  return container;
}

createSearchSkeleton() {
  const container = document.createElement('div');
  container.className = 'zoro-search-container zoro-search-skeleton';
  container.innerHTML = `
    <div class="zoro-search-input-container">
      <input type="text" class="zoro-search-input" disabled placeholder="Loading search...">
    </div>
    <div class="zoro-search-results">
      <div class="zoro-cards-grid">
        ${Array(3).fill().map(() => `
          <div class="zoro-card zoro-skeleton">
            <div class="skeleton-cover"></div>
            <div class="media-info">
              <div class="skeleton-title"></div>
              <div class="skeleton-details">
                <span class="skeleton-badge"></span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  return container;
}

createMediaCard(data, config, options = {}) {
  const isSearch = options.isSearch || false;
  const isCompact = config.layout === 'compact';
  const entry = isSearch ? null : data; // null for search results
  const media = isSearch ? data : data.media;

  const card = document.createElement('div');
  card.className = `zoro-card ${isCompact ? 'compact' : ''}`;

  // Cover Image (shared) - now press and hold for more details
  if (this.plugin.settings.showCoverImages && media.coverImage?.large) {
    const img = document.createElement('img');
    img.src = media.coverImage.large;
    img.alt = media.title.english || media.title.romaji;
    img.className = 'media-cover pressable-cover';
    img.loading = 'lazy'; // Performance boost
    
    let pressTimer = null;
    let isPressed = false;
    const pressHoldDuration = 400; // 500ms hold time
    
    // Mouse events
    img.onmousedown = (e) => {
      e.preventDefault();
      isPressed = true;
      img.style.opacity = '0.7';
      
      pressTimer = setTimeout(() => {
        if (isPressed) {
          this.plugin.moreDetailsPanel.showPanel(media, entry, img);
          img.style.opacity = '1';
          isPressed = false;
        }
      }, pressHoldDuration);
    };
    
    img.onmouseup = img.onmouseleave = (e) => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      img.style.opacity = '1';
      isPressed = false;
    };
    
    // Touch events for mobile
    img.ontouchstart = (e) => {
      e.preventDefault();
      isPressed = true;
      img.style.opacity = '0.7';
      
      pressTimer = setTimeout(() => {
        if (isPressed) {
          this.plugin.moreDetailsPanel.showPanel(media, entry, img);
          img.style.opacity = '1';
          isPressed = false;
        }
      }, pressHoldDuration);
    };
    
    img.ontouchend = img.ontouchcancel = (e) => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      img.style.opacity = '1';
      isPressed = false;
    };
    
    // Add visual feedback for press and hold
    img.style.cursor = 'pointer';
    img.title = 'Press and hold for more details';
    img.style.transition = 'opacity 0.1s ease';
    
    card.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'media-info';

  // Title (shared)
  const title = document.createElement('h4');
  const titleLink = document.createElement('a');
  titleLink.href = this.plugin.getZoroUrl(media.id, config.mediaType);
  titleLink.target = '_blank';
  titleLink.textContent = media.title.english || media.title.romaji;
  title.appendChild(titleLink);
  info.appendChild(title);

  // Details section (conditional)
  if (!isCompact) {
    const details = document.createElement('div');
    details.className = 'media-details';

    // Format badge
    if (media.format) {
      const formatBadge = document.createElement('span');
      formatBadge.className = 'format-badge';
      formatBadge.textContent = media.format;
      details.appendChild(formatBadge);
    }

    // Status badge (only for list entries)
    if (!isSearch && entry) {
      const statusBadge = document.createElement('span');
      statusBadge.className = `status-badge status-${entry.status.toLowerCase()} clickable-status`;
      statusBadge.textContent = entry.status;
      statusBadge.onclick = (e) => this.handleStatusClick(e, entry, statusBadge);
      details.appendChild(statusBadge);
    }

    // Progress (only for list entries)
    if (!isSearch && entry && this.plugin.settings.showProgress) {
      const progress = document.createElement('span');
      progress.className = 'progress';
      const total = media.episodes || media.chapters || '?';
      progress.textContent = `${entry.progress || 0}/${total}`;
      details.appendChild(progress);
    }

    // Rating (shared)
    if (this.plugin.settings.showRatings) {
      const score = isSearch ? media.averageScore : entry?.score;
      if (score != null) {
        const rating = document.createElement('span');
        rating.className = 'score';
        rating.textContent = `★ ${score}`;
        details.appendChild(rating);
      }
    }

    // Search-specific add button
    if (isSearch) {
      const addBtn = document.createElement('span');
      addBtn.className = 'status-badge status-add clickable-status';
      addBtn.textContent = 'ADD';
      addBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!this.plugin.settings.accessToken) {
          this.plugin.prompt.createAuthenticationPrompt();
          return;
        }

        // Use a consistent entry structure (no fake entry needed)
        const entryData = {
          media: media,
          status: 'PLANNING', // Default starting status
          progress: 0,
          score: null,
          id: null // Indicates this is a new entry
        };

        this.plugin.edit.createEditModal(
          entryData,
          async (updates) => {
            // Use the same update method for both add and edit
            await this.plugin.api.updateMediaListEntry(media.id, updates);
            new Notice('✅ Added!');
            
            // Refresh any visible lists
            const containers = document.querySelectorAll('.zoro-container');
            containers.forEach(container => {
              const block = container.closest('.markdown-rendered')?.querySelector('code');
              if (block) {
                this.plugin.processor.processZoroCodeBlock(block.textContent, container, {});
              }
            });
          },
          () => {} // onCancel - do nothing
        );
      };
      details.appendChild(addBtn);
    }

    info.appendChild(details);
  }

  // Genres (shared)
  if (!isCompact && this.plugin.settings.showGenres && media.genres?.length) {
    const genres = document.createElement('div');
    genres.className = 'genres';
    media.genres.slice(0, 3).forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = g;
      genres.appendChild(tag);
    });
    info.appendChild(genres);
  }

  // Removed the separate "More" button since cover image now handles this functionality

  card.appendChild(info);
  return card;
}

attachEventListeners(card, entry, media, config) {
  // Status badge click (for existing entries)
  const statusBadge = card.querySelector('.clickable-status[data-entry-id]');
  if (statusBadge) {
    statusBadge.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleStatusClick(e, entry, statusBadge);
    };
  }
  
  // Add button click (for search results)
  const addBtn = card.querySelector('.clickable-status[data-media-id]');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleAddClick(e, media, config);
    };
  }
}


// Helper methods
handleStatusClick(e, entry, badge) {
  e.preventDefault();
  e.stopPropagation();
  if (!this.plugin.settings.accessToken) {
    this.plugin.prompt.createAuthenticationPrompt();
    return;
  }
  this.plugin.handleEditClick(e, entry, badge);
}

handleAddClick(e, media, config) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.target;
  btn.textContent = '⏳';
  btn.disabled = true;
  
  this.plugin.api.addMediaToList(media.id, { status: 'PLANNING' }, config.mediaType)
    .then(() => {
      btn.textContent = '✅';
      new Notice('Added to list!');
    })
    .catch(err => {
      btn.textContent = 'ADD';
      btn.disabled = false;
      new Notice(`❌ ${err.message}`);
    });
}

  /* ----------  UTILITIES  ---------- */
  clear(el) { el.empty?.(); }
}

class MoreDetailsPanel {
  constructor(plugin) {
    this.plugin = plugin;
    this.currentPanel = null;
  }

  /**
   * Creates and shows the detailed panel for a media item
   * @param {Object} media - The media object from AniList
   * @param {Object} entry - The list entry (null for search results)
   * @param {HTMLElement} triggerElement - The element that triggered the panel
   */
  async showPanel(media, entry = null, triggerElement) {
    // Close any existing panel first
    this.closePanel();

    // Show loading panel first
    const loadingPanel = this.createLoadingPanel();
    this.currentPanel = loadingPanel;
    this.positionPanel(loadingPanel, triggerElement);
    document.body.appendChild(loadingPanel);

    try {
      // Fetch detailed media data
      const detailedMedia = await this.fetchDetailedMediaData(media.id);
      
      // Replace loading panel with actual content
      loadingPanel.remove();
      
      const panel = this.createPanel(detailedMedia, entry);
      this.currentPanel = panel;
      this.positionPanel(panel, triggerElement);
      document.body.appendChild(panel);

      // Add click-outside-to-close functionality
      setTimeout(() => {
        document.addEventListener('click', this.handleOutsideClick.bind(this));
      }, 100);

    } catch (error) {
      console.error('Failed to fetch detailed media data:', error);
      
      // Fallback: show panel with available data
      loadingPanel.remove();
      const panel = this.createPanel(media, entry);
      this.currentPanel = panel;
      this.positionPanel(panel, triggerElement);
      document.body.appendChild(panel);

      setTimeout(() => {
        document.addEventListener('click', this.handleOutsideClick.bind(this));
      }, 100);
    }
  }

  createPanel(media, entry) {
    const panel = document.createElement('div');
    panel.className = 'zoro-more-details-panel';

    // Create scrollable content container
    const content = document.createElement('div');
    content.className = 'panel-content';

    // Header section
    content.appendChild(this.createHeaderSection(media));

    // Synopsis section - Enhanced with better fallback
    if (media.description) {
      content.appendChild(this.createSynopsisSection(media.description));
    }

    // Metadata section
    content.appendChild(this.createMetadataSection(media, entry));

    // Statistics section - Enhanced with better data handling
    content.appendChild(this.createStatisticsSection(media));

    // Genres section - NEW: Display genres separately from tags
    if (media.genres?.length) {
      content.appendChild(this.createGenresSection(media.genres));
    }

    // Tags section - Enhanced with better filtering
    if (media.tags?.length) {
      content.appendChild(this.createTagsSection(media.tags));
    }

    // Characters section (if available)
    if (media.characters?.edges?.length) {
      content.appendChild(this.createCharactersSection(media.characters));
    }

    // Staff section (if available)
    if (media.staff?.edges?.length) {
      content.appendChild(this.createStaffSection(media.staff));
    }

    // Studios section (for anime)
    if (media.studios?.edges?.length) {
      content.appendChild(this.createStudiosSection(media.studios));
    }

    // Relations section
    if (media.relations?.edges?.length) {
      content.appendChild(this.createRelationsSection(media.relations));
    }

    // External Links section - Enhanced
    if (media.externalLinks?.length || media.trailer || media.siteUrl) {
      content.appendChild(this.createLinksSection(media));
    }

    // Additional Info section - NEW: Background and other info
    const additionalInfo = this.createAdditionalInfoSection(media);
    if (additionalInfo) {
      content.appendChild(additionalInfo);
    }

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.onclick = () => this.closePanel();

    panel.appendChild(closeBtn);
    panel.appendChild(content);

    return panel;
  }

  createHeaderSection(media) {
    const header = document.createElement('div');
    header.className = 'panel-header';

    // Title section
    const titleSection = document.createElement('div');
    titleSection.className = 'title-section';
    
    const mainTitle = document.createElement('h2');
    mainTitle.className = 'main-title';
    mainTitle.textContent = media.title?.english || media.title?.romaji || 'Unknown Title';
    titleSection.appendChild(mainTitle);

    // Alternative titles
    if (media.title?.romaji && media.title?.english && media.title.romaji !== media.title.english) {
      const altTitle = document.createElement('div');
      altTitle.className = 'alt-title';
      altTitle.textContent = media.title.romaji;
      titleSection.appendChild(altTitle);
    }

    if (media.title?.native) {
      const nativeTitle = document.createElement('div');
      nativeTitle.className = 'native-title';
      nativeTitle.textContent = media.title.native;
      titleSection.appendChild(nativeTitle);
    }

    header.appendChild(titleSection);

    // Format and season info
    const formatInfo = document.createElement('div');
    formatInfo.className = 'format-info';
    
    if (media.format) {
      const format = document.createElement('span');
      format.className = 'format-badge-large';
      format.textContent = this.formatDisplayName(media.format);
      formatInfo.appendChild(format);
    }

    if (media.season && media.seasonYear) {
      const season = document.createElement('span');
      season.className = 'season-info';
      season.textContent = `${this.capitalize(media.season)} ${media.seasonYear}`;
      formatInfo.appendChild(season);
    }

    header.appendChild(formatInfo);
    return header;
  }

  createSynopsisSection(description) {
    const section = document.createElement('div');
    section.className = 'panel-section synopsis-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Synopsis';
    section.appendChild(title);

    const synopsis = document.createElement('div');
    synopsis.className = 'synopsis-content';
    
    // Clean HTML tags and format text better
    let cleanDescription = description
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
    
    synopsis.textContent = cleanDescription;
    section.appendChild(synopsis);

    return section;
  }

  createMetadataSection(media, entry) {
    const section = document.createElement('div');
    section.className = 'panel-section metadata-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Details';
    section.appendChild(title);

    const metaGrid = document.createElement('div');
    metaGrid.className = 'metadata-grid';

    // Status
    if (media.status) {
      this.addMetadataItem(metaGrid, 'Status', this.formatDisplayName(media.status));
    }

    // Episodes/Chapters/Volumes
    if (media.episodes) {
      this.addMetadataItem(metaGrid, 'Episodes', media.episodes);
    }
    if (media.chapters) {
      this.addMetadataItem(metaGrid, 'Chapters', media.chapters);
    }
    if (media.volumes) {
      this.addMetadataItem(metaGrid, 'Volumes', media.volumes);
    }

    // Duration (for anime)
    if (media.duration) {
      this.addMetadataItem(metaGrid, 'Episode Duration', `${media.duration} min`);
    }

    // Start/End dates
    if (media.startDate?.year) {
      const startDate = this.formatDate(media.startDate);
      this.addMetadataItem(metaGrid, 'Start Date', startDate);
    }
    if (media.endDate?.year) {
      const endDate = this.formatDate(media.endDate);
      this.addMetadataItem(metaGrid, 'End Date', endDate);
    }

    // Source
    if (media.source) {
      this.addMetadataItem(metaGrid, 'Source', this.formatDisplayName(media.source));
    }

    // Adult rating
    if (media.isAdult) {
      this.addMetadataItem(metaGrid, 'Rating', '18+');
    }

    // Synonyms
    if (media.synonyms?.length) {
      const synonymsText = media.synonyms.slice(0, 3).join(', ');
      this.addMetadataItem(metaGrid, 'Also Known As', synonymsText);
    }

    section.appendChild(metaGrid);
    return section;
  }

  createStatisticsSection(media) {
    const section = document.createElement('div');
    section.className = 'panel-section stats-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Statistics';
    section.appendChild(title);

    const statsGrid = document.createElement('div');
    statsGrid.className = 'stats-grid';

    // Average Score (Community Score)
    if (media.averageScore) {
      this.addStatItem(statsGrid, 'Community Score', `${media.averageScore}%`, 'score-stat');
    }

    // Mean Score (may be different from average)
    if (media.meanScore && media.meanScore !== media.averageScore) {
      this.addStatItem(statsGrid, 'Mean Score', `${media.meanScore}%`, 'score-stat');
    }

    // Popularity ranking
    if (media.popularity) {
      this.addStatItem(statsGrid, 'Popularity Rank', `#${media.popularity}`, 'popularity-stat');
    }

    // Favorites count
    if (media.favourites) {
      this.addStatItem(statsGrid, 'Favorites', media.favourites.toLocaleString(), 'favorites-stat');
    }

    // Trending ranking
    if (media.trending) {
      this.addStatItem(statsGrid, 'Trending Rank', `#${media.trending}`, 'trending-stat');
    }

    section.appendChild(statsGrid);
    return section;
  }

  // NEW: Separate genres section
  createGenresSection(genres) {
    const section = document.createElement('div');
    section.className = 'panel-section genres-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Genres';
    section.appendChild(title);

    const genresContainer = document.createElement('div');
    genresContainer.className = 'genres-container';

    genres.forEach(genre => {
      const genreElement = document.createElement('span');
      genreElement.className = 'genre-tag';
      genreElement.textContent = genre;
      genresContainer.appendChild(genreElement);
    });

    section.appendChild(genresContainer);
    return section;
  }

  createTagsSection(tags) {
    const section = document.createElement('div');
    section.className = 'panel-section tags-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Tags';
    section.appendChild(title);

    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'tags-container';

    // Filter out spoiler tags by default, sort by rank
    const visibleTags = tags
      .filter(tag => !tag.isMediaSpoiler)
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .slice(0, 12);

    const spoilerTags = tags
      .filter(tag => tag.isMediaSpoiler)
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .slice(0, 3);

    // Add visible tags
    visibleTags.forEach(tag => {
      const tagElement = document.createElement('span');
      tagElement.className = 'detail-tag';
      tagElement.textContent = tag.name;
      tagsContainer.appendChild(tagElement);
    });

    // Add spoiler tags with special styling
    spoilerTags.forEach(tag => {
      const tagElement = document.createElement('span');
      tagElement.className = 'detail-tag spoiler-tag';
      tagElement.textContent = tag.name;
      tagElement.title = 'Contains spoilers - click to reveal';
      tagElement.onclick = () => {
        tagElement.classList.toggle('revealed');
      };
      tagsContainer.appendChild(tagElement);
    });

    section.appendChild(tagsContainer);
    return section;
  }

  createCharactersSection(characters) {
    const section = document.createElement('div');
    section.className = 'panel-section characters-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Main Characters';
    section.appendChild(title);

    const charactersGrid = document.createElement('div');
    charactersGrid.className = 'characters-grid';

    // Show main characters first, then supporting
    const mainCharacters = characters.edges
      .filter(edge => edge.role === 'MAIN')
      .slice(0, 6);
    
    const supportingCharacters = characters.edges
      .filter(edge => edge.role === 'SUPPORTING')
      .slice(0, Math.max(0, 6 - mainCharacters.length));

    const displayCharacters = [...mainCharacters, ...supportingCharacters];

    displayCharacters.forEach(edge => {
      const charCard = document.createElement('div');
      charCard.className = 'character-card';

      if (edge.node.image?.medium) {
        const img = document.createElement('img');
        img.src = edge.node.image.medium;
        img.alt = edge.node.name?.full || 'Unknown Character';
        img.className = 'character-image';
        img.onerror = () => {
          img.style.display = 'none';
        };
        charCard.appendChild(img);
      }

      const name = document.createElement('div');
      name.className = 'character-name';
      name.textContent = edge.node.name?.full || 'Unknown Character';
      charCard.appendChild(name);

      const role = document.createElement('div');
      role.className = 'character-role';
      role.textContent = this.capitalize(edge.role || '');
      charCard.appendChild(role);

      charactersGrid.appendChild(charCard);
    });

    section.appendChild(charactersGrid);
    return section;
  }

  createStaffSection(staff) {
    const section = document.createElement('div');
    section.className = 'panel-section staff-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Staff';
    section.appendChild(title);

    const staffList = document.createElement('div');
    staffList.className = 'staff-list';

    // Show key staff, prioritize directors, writers, etc.
    const priorityRoles = ['Director', 'Original Creator', 'Script', 'Character Design', 'Music'];
    const keyStaff = staff.edges
      .sort((a, b) => {
        const aPriority = priorityRoles.indexOf(a.role) !== -1 ? priorityRoles.indexOf(a.role) : 999;
        const bPriority = priorityRoles.indexOf(b.role) !== -1 ? priorityRoles.indexOf(b.role) : 999;
        return aPriority - bPriority;
      })
      .slice(0, 8);

    keyStaff.forEach(edge => {
      const staffItem = document.createElement('div');
      staffItem.className = 'staff-item';

      const name = document.createElement('span');
      name.className = 'staff-name';
      name.textContent = edge.node.name?.full || 'Unknown Staff';

      const role = document.createElement('span');
      role.className = 'staff-role';
      role.textContent = edge.role || 'Unknown Role';

      staffItem.appendChild(name);
      staffItem.appendChild(role);
      staffList.appendChild(staffItem);
    });

    section.appendChild(staffList);
    return section;
  }

  createStudiosSection(studios) {
    const section = document.createElement('div');
    section.className = 'panel-section studios-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Studios';
    section.appendChild(title);

    const studiosList = document.createElement('div');
    studiosList.className = 'studios-list';

    studios.edges.forEach(edge => {
      const studio = document.createElement('span');
      studio.className = 'studio-name';
      studio.textContent = edge.node.name;
      studiosList.appendChild(studio);
    });

    section.appendChild(studiosList);
    return section;
  }

  createRelationsSection(relations) {
    const section = document.createElement('div');
    section.className = 'panel-section relations-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Related Media';
    section.appendChild(title);

    const relationsList = document.createElement('div');
    relationsList.className = 'relations-list';

    // Sort relations by importance
    const relationOrder = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'ADAPTATION', 'SPIN_OFF', 'OTHER'];
    const sortedRelations = relations.edges.sort((a, b) => {
      const aIndex = relationOrder.indexOf(a.relationType) !== -1 ? relationOrder.indexOf(a.relationType) : 999;
      const bIndex = relationOrder.indexOf(b.relationType) !== -1 ? relationOrder.indexOf(b.relationType) : 999;
      return aIndex - bIndex;
    });

    sortedRelations.forEach(edge => {
      const relation = document.createElement('div');
      relation.className = 'relation-item';

      const relationType = document.createElement('span');
      relationType.className = 'relation-type';
      relationType.textContent = this.formatDisplayName(edge.relationType);

      const mediaTitle = document.createElement('span');
      mediaTitle.className = 'relation-title';
      mediaTitle.textContent = edge.node.title?.english || edge.node.title?.romaji || 'Unknown Title';

      const mediaFormat = document.createElement('span');
      mediaFormat.className = 'relation-format';
      mediaFormat.textContent = edge.node.format ? `(${this.formatDisplayName(edge.node.format)})` : '';

      relation.appendChild(relationType);
      relation.appendChild(mediaTitle);
      if (mediaFormat.textContent) {
        relation.appendChild(mediaFormat);
      }
      relationsList.appendChild(relation);
    });

    section.appendChild(relationsList);
    return section;
  }

  createLinksSection(media) {
    const section = document.createElement('div');
    section.className = 'panel-section links-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'External Links';
    section.appendChild(title);

    const linksContainer = document.createElement('div');
    linksContainer.className = 'links-container';

    // AniList link (always available if siteUrl exists)
    if (media.siteUrl) {
      const anilistLink = document.createElement('a');
      anilistLink.href = media.siteUrl;
      anilistLink.target = '_blank';
      anilistLink.className = 'external-link anilist-link';
      anilistLink.textContent = 'View on AniList';
      linksContainer.appendChild(anilistLink);
    }

    // Trailer
    if (media.trailer?.id) {
      const trailerLink = document.createElement('a');
      if (media.trailer.site === 'youtube') {
        trailerLink.href = `https://www.youtube.com/watch?v=${media.trailer.id}`;
      } else if (media.trailer.site === 'dailymotion') {
        trailerLink.href = `https://www.dailymotion.com/video/${media.trailer.id}`;
      }
      trailerLink.target = '_blank';
      trailerLink.className = 'external-link trailer-link';
      trailerLink.textContent = 'Watch Trailer';
      linksContainer.appendChild(trailerLink);
    }

    // Other external links
    if (media.externalLinks?.length) {
      media.externalLinks.slice(0, 6).forEach(link => {
        if (link.url && link.site) {
          const extLink = document.createElement('a');
          extLink.href = link.url;
          extLink.target = '_blank';
          extLink.className = 'external-link';
          extLink.textContent = link.site;
          linksContainer.appendChild(extLink);
        }
      });
    }

    section.appendChild(linksContainer);
    return section;
  }

  // NEW: Additional info section for background, hashtags, etc.
  createAdditionalInfoSection(media) {
    const hasAdditionalInfo = media.hashtag || media.synonyms?.length > 3;
    
    if (!hasAdditionalInfo) return null;

    const section = document.createElement('div');
    section.className = 'panel-section additional-info-section';

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Additional Information';
    section.appendChild(title);

    const infoContainer = document.createElement('div');
    infoContainer.className = 'additional-info-container';

    // Hashtag
    if (media.hashtag) {
      const hashtagItem = document.createElement('div');
      hashtagItem.className = 'info-item';
      
      const hashtagLabel = document.createElement('span');
      hashtagLabel.className = 'info-label';
      hashtagLabel.textContent = 'Official Hashtag:';
      
      const hashtagValue = document.createElement('span');
      hashtagValue.className = 'info-value hashtag';
      hashtagValue.textContent = media.hashtag;
      
      hashtagItem.appendChild(hashtagLabel);
      hashtagItem.appendChild(hashtagValue);
      infoContainer.appendChild(hashtagItem);
    }

    // All synonyms if there are many
    if (media.synonyms?.length > 3) {
      const synonymsItem = document.createElement('div');
      synonymsItem.className = 'info-item';
      
      const synonymsLabel = document.createElement('span');
      synonymsLabel.className = 'info-label';
      synonymsLabel.textContent = 'Alternative Titles:';
      
      const synonymsValue = document.createElement('div');
      synonymsValue.className = 'info-value synonyms-list';
      
      media.synonyms.slice(0, 8).forEach(synonym => {
        const synonymSpan = document.createElement('span');
        synonymSpan.className = 'synonym';
        synonymSpan.textContent = synonym;
        synonymsValue.appendChild(synonymSpan);
      });
      
      synonymsItem.appendChild(synonymsLabel);
      synonymsItem.appendChild(synonymsValue);
      infoContainer.appendChild(synonymsItem);
    }

    section.appendChild(infoContainer);
    return section;
  }

  // Helper methods
  async fetchDetailedMediaData(mediaId) {
    // Use the API class method instead of defining the query here
    const response = await this.plugin.api.getDetailedMedia(mediaId);
    return response.data.Media;
  }

  createLoadingPanel() {
    const panel = document.createElement('div');
    panel.className = 'zoro-more-details-panel loading-panel';

    const content = document.createElement('div');
    content.className = 'panel-content loading-content';
    
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    spinner.textContent = 'Loading detailed information...';
    
    content.appendChild(spinner);
    panel.appendChild(content);

    return panel;
  }

  addMetadataItem(container, label, value) {
    if (!value) return; // Skip empty values
    
    const item = document.createElement('div');
    item.className = 'metadata-item';

    const labelEl = document.createElement('span');
    labelEl.className = 'metadata-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'metadata-value';
    valueEl.textContent = value;

    item.appendChild(labelEl);
    item.appendChild(valueEl);
    container.appendChild(item);
  }

  addStatItem(container, label, value, className = '') {
    if (!value) return; // Skip empty values
    
    const item = document.createElement('div');
    item.className = `stat-item ${className}`;

    const labelEl = document.createElement('span');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'stat-value';
    valueEl.textContent = value;

    item.appendChild(labelEl);
    item.appendChild(valueEl);
    container.appendChild(item);
  }

  formatDate(dateObj) {
    if (!dateObj?.year) return 'Unknown';
    
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    let result = '';
    if (dateObj.month) result += months[dateObj.month - 1] + ' ';
    if (dateObj.day) result += dateObj.day + ', ';
    result += dateObj.year;
    
    return result;
  }

  formatDisplayName(str) {
    if (!str) return '';
    return str.replace(/_/g, ' ')
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
  }

  capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  positionPanel(panel, triggerElement) {
    // Simple center positioning - you can enhance this based on trigger position
    panel.style.position = 'fixed';
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
    panel.style.zIndex = '1000';
    panel.style.maxHeight = '80vh';
    panel.style.maxWidth = '90vw';
    panel.style.width = '600px';
  }

  handleOutsideClick(event) {
    if (this.currentPanel && !this.currentPanel.contains(event.target)) {
      this.closePanel();
    }
  }

  closePanel() {
    if (this.currentPanel) {
      document.removeEventListener('click', this.handleOutsideClick.bind(this));
      this.currentPanel.remove();
      this.currentPanel = null;
    }
  }
}
// Authentication
class Authentication {
  constructor(plugin) {
    this.plugin = plugin;        // gives us access to plugin.settings & requestQueue
  }

  /* ---------- constants ---------- */
  static ANILIST_AUTH_URL  = 'https://anilist.co/api/v2/oauth/authorize';
  static ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
  static REDIRECT_URI      = 'https://anilist.co/api/v2/oauth/pin';

  /* ---------- public getter ---------- */
  get isLoggedIn() {
    return Boolean(this.plugin.settings.accessToken);
  }

  /* ---------- OAuth helpers ---------- */
  async loginWithFlow() {
    // 1. Ensure we have client credentials
    if (!this.plugin.settings.clientId) {
      new Notice('❌ Please enter your Client ID first.', 5000);
      return;
    }

    // 2. Build auth url
    const { clientId } = this.plugin.settings;
    const authUrl =
      `${Authentication.ANILIST_AUTH_URL}?` +
      new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  Authentication.REDIRECT_URI,
        response_type: 'code'
      }).toString();

    // 3. Open browser
    new Notice('🔐 Opening AniList login page…', 3000);
    if (window.require) {
      const { shell } = window.require('electron');
      await shell.openExternal(authUrl);
    } else {
      window.open(authUrl, '_blank');
    }

    // 4. Prompt for pin
    const pin = await this.promptModal('Paste the PIN code from the browser:');
    if (!pin) return;

    // 5. Exchange pin → token
    await this.exchangePin(pin);
  }

  async logout() {
    this.plugin.settings.accessToken  = '';
    this.plugin.settings.tokenExpiry  = 0;
    this.plugin.settings.authUsername = '';
    this.plugin.settings.clientId     = '';
    this.plugin.settings.clientSecret = '';
    await this.plugin.saveSettings();

    // Clear caches
    this.plugin.cache.userData.clear();
    this.plugin.cache.mediaData.clear();
    this.plugin.cache.searchResults.clear();

    new Notice('✅ Logged out & cleared credentials.', 3000);
  }

  /* ---------- internal helpers ---------- */
  async exchangePin(pin) {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code:          pin.trim(),
      client_id:     this.plugin.settings.clientId,
      client_secret: this.plugin.settings.clientSecret || '',
      redirect_uri:  Authentication.REDIRECT_URI
    });

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json'
    };

    try {
      const res = await this.plugin.requestQueue.add(() =>
        requestUrl({
          url:    Authentication.ANILIST_TOKEN_URL,
          method: 'POST',
          headers,
          body:   body.toString()
        })
      );

      const data = res.json;
      if (!data?.access_token) {
        throw new Error(data.error_description || 'No token returned');
      }

      this.plugin.settings.accessToken = data.access_token;
      if (data.expires_in) {
        this.plugin.settings.tokenExpiry = Date.now() + data.expires_in * 1000;
      }
      await this.plugin.saveSettings();

      new Notice('✅ Authenticated successfully!', 4000);
    } catch (err) {
      new Notice(`❌ Auth failed: ${err.message}`, 5000);
      throw err;
    }
  }

  async promptModal(message) {
    // Simple synchronous prompt (works in Obsidian)
    return new Promise((res) => {
      const val = prompt(message);
      res(val ? val.trim() : null);
    });
  }

  async ensureValidToken() {
    if (!this.isLoggedIn) throw new Error('Not authenticated');
    return true;
  }
  
  async getAuthenticatedUsername() {
    await this.ensureValidToken();

    const query = `query { Viewer { name } }`;
    const res = await this.plugin.requestQueue.add(() =>
      requestUrl({
        url:     'https://graphql.anilist.co',
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${this.plugin.settings.accessToken}`
        },
        body: JSON.stringify({ query })
      })
    );

    const name = res.json?.data?.Viewer?.name;
    if (!name) throw new Error('Could not fetch username');
    this.plugin.settings.authUsername = name;
    await this.plugin.saveSettings();
    return name;
  }
}

class ClientIdModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('auth-modal');
    
    contentEl.createEl('h2', { text: '🔑 Enter Client ID' });
    
    const desc = contentEl.createEl('p');
    desc.setText('Enter your AniList application Client ID');
    desc.addClass('auth-modal-desc');
    
    const inputContainer = contentEl.createEl('div', { cls: 'auth-input-container' });
    
    const input = inputContainer.createEl('input', {
      type: 'text',
      placeholder: 'Client ID',
      cls: 'auth-input'
    });
    
    const buttonContainer = contentEl.createEl('div', { cls: 'auth-button-container' });
    
    const submitButton = buttonContainer.createEl('button', {
      text: 'Save',
      cls: 'mod-cta auth-button'
    });
    
    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'auth-button'
    });
    
    // Centralized close modal function
    const closeModal = () => {
      this.close();
    };
    
    submitButton.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) {
        this.onSubmit(value);
        closeModal();
      }
    });
    
    cancelButton.addEventListener('click', closeModal);
    
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        submitButton.click();
      }
    });
    
    setTimeout(() => input.focus(), 100);
  }
}

class ClientSecretModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('auth-modal');
    
    contentEl.createEl('h2', { text: '🔐 Enter Client Secret' });
    
    const desc = contentEl.createEl('p');
    desc.setText('Enter your AniList application Client Secret');
    desc.addClass('auth-modal-desc');
    
    const inputContainer = contentEl.createEl('div', { cls: 'auth-input-container' });
    
    const input = inputContainer.createEl('input', {
      type: 'password',
      placeholder: 'Client Secret',
      cls: 'auth-input'
    });
    
    const buttonContainer = contentEl.createEl('div', { cls: 'auth-button-container' });
    
    const submitButton = buttonContainer.createEl('button', {
      text: 'Save',
      cls: 'mod-cta auth-button'
    });
    
    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'auth-button'
    });
    
    // Centralized close modal function
    const closeModal = () => {
      this.close();
    };
    
    submitButton.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) {
        this.onSubmit(value);
        closeModal();
      }
    });
    
    cancelButton.addEventListener('click', closeModal);
    
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        submitButton.click();
      }
    });
    
    setTimeout(() => input.focus(), 100);
  }
}

class AuthPinModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('auth-modal pin-modal');
    
    contentEl.createEl('h2', { text: '🔓 Complete Authentication' });
    
    const desc = contentEl.createEl('p');
    desc.setText('Copy the authorization code from the browser and paste it below');
    desc.addClass('auth-modal-desc');
    
    const inputContainer = contentEl.createEl('div', { cls: 'auth-input-container' });
    
    const input = inputContainer.createEl('input', {
      type: 'text',
      placeholder: 'Paste authorization code here',
      cls: 'auth-input pin-input'
    });
    
    const buttonContainer = contentEl.createEl('div', { cls: 'auth-button-container' });
    
    const submitButton = buttonContainer.createEl('button', {
      text: '✅ Complete Authentication',
      cls: 'mod-cta auth-button submit-button'
    });
    
    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'auth-button'
    });
    
    // Centralized close modal function
    const closeModal = () => {
      this.close();
    };
    
    submitButton.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) {
        this.onSubmit(value);
        closeModal();
      }
    });
    
    cancelButton.addEventListener('click', closeModal);
    
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        submitButton.click();
      }
    });
    
    input.addEventListener('input', (e) => {
      const value = e.target.value.trim();
      if (value) {
        submitButton.classList.add('ready');
      } else {
        submitButton.classList.remove('ready');
      }
    });
    
    setTimeout(() => input.focus(), 100);
  }
}
// Theme
class Theme {
  constructor(plugin) {
    this.plugin = plugin;
    this.themeStyleId = 'zoro-theme';
    this.pluginScopes = [
      '.zoro-container',
      '.zoro-search-container',
      '.zoro-dashboard-container',
      '.zoro-modal-overlay',
      '.zoro-edit-modal',
      '.zoro-auth-modal'
    ];
  }

  async getAvailableThemes() {
    try {
      const themesDir = `${this.plugin.manifest.dir}/themes`;
      const { files } = await this.plugin.app.vault.adapter.list(themesDir);
      return files
        .filter(f => f.endsWith('.css'))
        .map(f => f.split('/').pop().replace('.css', ''));
    } catch {
      return [];
    }
  }

  async applyTheme(themeName) {
    const old = document.getElementById(this.themeStyleId);
    if (old) old.remove();

    if (!themeName) return;

    const cssPath = `${this.plugin.manifest.dir}/themes/${themeName}.css`;
    let rawCss;
    try {
      rawCss = await this.plugin.app.vault.adapter.read(cssPath);
    } catch (err) {
      console.warn('Zoro: theme file missing:', themeName, err);
      new Notice(`❌ Theme "${themeName}" not found`);
      return;
    }

    const scopedCss = this.scopeToPlugin(rawCss);

    const style = document.createElement('style');
    style.id = this.themeStyleId;
    style.textContent = scopedCss;
    document.head.appendChild(style);
  }

  scopeToPlugin(css) {
    const rules = this.extractCSSRules(css);
    const scopedRules = [];

    for (const rule of rules) {
      if (rule.type === 'at-rule') {
        scopedRules.push(this.handleAtRule(rule));
      } else if (rule.type === 'rule') {
        scopedRules.push(this.handleRegularRule(rule));
      } else {
        scopedRules.push(rule.content);
      }
    }

    return scopedRules.join('\n');
  }

  extractCSSRules(css) {
    const rules = [];
    let pos = 0;
    let current = '';
    let braceDepth = 0;
    let inAtRule = false;
    let atRuleType = '';

    while (pos < css.length) {
      const char = css[pos];
      current += char;

      if (char === '@' && braceDepth === 0) {
        if (current.slice(0, -1).trim()) {
          rules.push({ type: 'text', content: current.slice(0, -1) });
        }
        current = char;
        inAtRule = true;
        const match = css.slice(pos).match(/^@(\w+)/);
        atRuleType = match ? match[1] : '';
      }

      if (char === '{') {
        braceDepth++;
      } else if (char === '}') {
        braceDepth--;
        
        if (braceDepth === 0) {
          if (inAtRule) {
            rules.push({ type: 'at-rule', content: current, atType: atRuleType });
            inAtRule = false;
            atRuleType = '';
          } else {
            rules.push({ type: 'rule', content: current });
          }
          current = '';
        }
      }

      pos++;
    }

    if (current.trim()) {
      rules.push({ type: 'text', content: current });
    }

    return rules;
  }

  handleAtRule(rule) {
    if (rule.atType === 'media') {
      const mediaMatch = rule.content.match(/^(@media[^{]+)\{(.*)\}$/s);
      if (mediaMatch) {
        const mediaQuery = mediaMatch[1];
        const innerCSS = mediaMatch[2];
        const scopedInner = this.scopeToPlugin(innerCSS);
        return `${mediaQuery} {\n${scopedInner}\n}`;
      }
    }
    return rule.content;
  }

  handleRegularRule(rule) {
    const match = rule.content.match(/^([^{]+)\{(.*)\}$/s);
    if (!match) return rule.content;

    const selectors = match[1].trim();
    const declarations = match[2];

    const selectorList = selectors.split(',').map(s => s.trim());
    const scopedSelectors = [];

    for (const selector of selectorList) {
      if (this.isAlreadyPluginScoped(selector)) {
        scopedSelectors.push(selector);
      } else if (this.shouldBePluginScoped(selector)) {
        scopedSelectors.push(this.addPluginScope(selector));
      } else {
        scopedSelectors.push(selector);
      }
    }

    return `${scopedSelectors.join(', ')} {${declarations}}`;
  }

  isAlreadyPluginScoped(selector) {
    return this.pluginScopes.some(scope => selector.includes(scope));
  }

  shouldBePluginScoped(selector) {
    const globalPrefixes = [':root', 'html', 'body', '*'];
    const pluginPrefixes = ['.zoro-', '#zoro-'];
    
    const hasGlobalPrefix = globalPrefixes.some(prefix => selector.startsWith(prefix));
    const hasPluginPrefix = pluginPrefixes.some(prefix => selector.includes(prefix));
    
    return !hasGlobalPrefix && (hasPluginPrefix || !selector.startsWith('.'));
  }

  addPluginScope(selector) {
    const primaryScope = '.zoro-container';
    
    if (selector.includes('.zoro-modal') || selector.includes('.zoro-overlay')) {
      return selector;
    }
    
    if (selector.startsWith(':')) {
      return `${primaryScope}${selector}`;
    }
    
    return `${primaryScope} ${selector}`;
  }

  removeTheme() {
    const existingStyle = document.getElementById(this.themeStyleId);
    if (existingStyle) {
      existingStyle.remove();
    }
  }
}
// Edit
class Edit {
  constructor(plugin) {
    this.plugin = plugin;
  }

 createEditModal(entry, onSave, onCancel) {
    const modal = document.createElement('div');
    modal.className = 'zoro-edit-modal';
    const overlay = document.createElement('div');
    overlay.className = 'zoro-modal-overlay';
    const content = document.createElement('div');
    content.className = 'zoro-modal-content';
    const form = document.createElement('form');
    form.className = 'zoro-edit-form';
    
    const title = document.createElement('h3');
    title.className = 'zoro-modal-title';
    title.textContent = entry.media.title.english || entry.media.title.romaji;
    
    // --- Status Field ---
    const statusGroup = this.createStatusField(entry);
    const statusSelect = statusGroup.querySelector('.zoro-status-select');
    
    // --- Score Field ---
    const scoreGroup = this.createScoreField(entry);
    const scoreInput = scoreGroup.querySelector('.zoro-score-input');
    
    // --- Progress Field ---
    const progressGroup = this.createProgressField(entry);
    const progressInput = progressGroup.querySelector('.zoro-progress-input');
    
    // --- Quick Buttons ---
    const quickProgressDiv = this.createQuickProgressButtons(entry, progressInput, statusSelect);
    
    // --- Buttons ---
    const buttonContainer = this.createButtonContainer(entry, onSave, onCancel, modal);
    const saveBtn = buttonContainer.querySelector('.zoro-save-btn');
    const removeBtn = buttonContainer.querySelector('.zoro-remove-btn');
    const cancelBtn = buttonContainer.querySelector('.zoro-cancel-btn');
    
    // Keyboard accessibility
    const escListener = this.createEscapeListener(onCancel, modal, () => {
        this.trySave(entry, onSave, saveBtn, statusSelect, scoreInput, progressInput, modal, escListener, closeModal);
    });
    
    // Centralized close modal function
    const closeModal = () => {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        document.removeEventListener('keydown', escListener);
        this.plugin.removeAllGlobalListeners();          // safest belt-and-braces
    };
    
    // Form submission
    form.onsubmit = async (e) => {
        e.preventDefault();
        await this.trySave(entry, onSave, saveBtn, statusSelect, scoreInput, progressInput, modal, escListener, closeModal);
    };
    
    // Setup remove button functionality
    this.setupRemoveButton(removeBtn, entry, modal, closeModal);
    
    form.append(title, statusGroup, scoreGroup, progressGroup, quickProgressDiv, buttonContainer);
    content.appendChild(form);
    modal.append(overlay, content);
    document.body.appendChild(modal);
    
    // Setup modal interactions using closeModal
    overlay.onclick = closeModal;                      // overlay click
    if (cancelBtn) cancelBtn.onclick = closeModal;     // Cancel button
    
    this.plugin.addGlobalListener(document, 'keydown', escListener);
    
    // Get and set favorite status
    this.setFavoriteStatus(entry, buttonContainer.querySelector('.zoro-fav-btn'));
}
  
  createStatusField(entry) {
    const statusGroup = document.createElement('div');
    statusGroup.className = 'zoro-form-group zoro-status-group';

    const statusLabel = document.createElement('label');
    statusLabel.className = 'zoro-form-label zoro-status-label';
    statusLabel.textContent = '🧿 Status';
    statusLabel.setAttribute('for', 'zoro-status');

    const statusSelect = document.createElement('select');
    statusSelect.className = 'zoro-form-input zoro-status-select';
    statusSelect.id = 'zoro-status';

    ['CURRENT', 'PLANNING', 'COMPLETED', 'DROPPED', 'PAUSED', 'REPEATING'].forEach(status => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      if (status === entry.status) option.selected = true;
      statusSelect.appendChild(option);
    });

    statusGroup.appendChild(statusLabel);
    statusGroup.appendChild(statusSelect);
    return statusGroup;
  }

  createScoreField(entry) {
    const scoreGroup = document.createElement('div');
    scoreGroup.className = 'zoro-form-group zoro-score-group';

    const scoreLabel = document.createElement('label');
    scoreLabel.className = 'zoro-form-label zoro-score-label';
    scoreLabel.textContent = '⭐ Score (0–10)';
    scoreLabel.setAttribute('for', 'zoro-score');

    const scoreInput = document.createElement('input');
    scoreInput.className = 'zoro-form-input zoro-score-input';
    scoreInput.type = 'number';
    scoreInput.id = 'zoro-score';
    scoreInput.min = '0';
    scoreInput.max = '10';
    scoreInput.step = '0.1';
    scoreInput.value = entry.score ?? '';
    scoreInput.placeholder = 'e.g. 8.5';

    scoreGroup.appendChild(scoreLabel);
    scoreGroup.appendChild(scoreInput);
    return scoreGroup;
  }

  createProgressField(entry) {
    const progressGroup = document.createElement('div');
    progressGroup.className = 'zoro-form-group zoro-progress-group';

    const progressLabel = document.createElement('label');
    progressLabel.className = 'zoro-form-label zoro-progress-label';
    progressLabel.textContent = '📊 Progress';
    progressLabel.setAttribute('for', 'zoro-progress');

    const progressInput = document.createElement('input');
    progressInput.className = 'zoro-form-input zoro-progress-input';
    progressInput.type = 'number';
    progressInput.id = 'zoro-progress';
    progressInput.min = '0';
    progressInput.max = entry.media.episodes || entry.media.chapters || 999;
    progressInput.value = entry.progress || 0;
    progressInput.placeholder = 'Progress';

    progressGroup.appendChild(progressLabel);
    progressGroup.appendChild(progressInput);
    return progressGroup;
  }

  createQuickProgressButtons(entry, progressInput, statusSelect) {
    const quickProgressDiv = document.createElement('div');
    quickProgressDiv.className = 'zoro-quick-progress-buttons';

    const plusOneBtn = document.createElement('button');
    plusOneBtn.className = 'zoro-quick-btn zoro-plus-btn';
    plusOneBtn.type = 'button';
    plusOneBtn.textContent = '+1';
    plusOneBtn.onclick = () => {
      const current = parseInt(progressInput.value) || 0;
      const max = progressInput.max;
      if (current < max) progressInput.value = current + 1;
    };

    const minusOneBtn = document.createElement('button');
    minusOneBtn.className = 'zoro-quick-btn zoro-minus-btn';
    minusOneBtn.type = 'button';
    minusOneBtn.textContent = '-1';
    minusOneBtn.onclick = () => {
      const current = parseInt(progressInput.value) || 0;
      if (current > 0) progressInput.value = current - 1;
    };

    const completeBtn = document.createElement('button');
    completeBtn.className = 'zoro-quick-btn zoro-complete-btn';
    completeBtn.type = 'button';
    completeBtn.textContent = 'Complete';
    completeBtn.onclick = () => {
      progressInput.value = entry.media.episodes || entry.media.chapters || 1;
      statusSelect.value = 'COMPLETED';
    };

    quickProgressDiv.append(plusOneBtn, minusOneBtn, completeBtn);
    return quickProgressDiv;
  }

  createButtonContainer(entry, onSave, onCancel, modal) {
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'zoro-modal-buttons';

    // ❤️ Favorite toggle
    const favBtn = document.createElement('button');
    favBtn.className = 'zoro-modal-btn zoro-fav-btn';
    favBtn.type = 'button';
    favBtn.title = 'Toggle Favorite';
    favBtn.textContent = '🤍';

    favBtn.onclick = async () => {
      await this.toggleFavorite(entry, favBtn);
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'zoro-modal-btn zoro-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.type = 'submit';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'zoro-modal-btn zoro-remove-btn';
    removeBtn.type = 'button';
    removeBtn.textContent = '🗑️';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'zoro-modal-btn zoro-cancel-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      onCancel();
      document.body.removeChild(modal);
    };

    buttonContainer.append(removeBtn, favBtn, saveBtn, cancelBtn);
    return buttonContainer;
  }

  setupRemoveButton(removeBtn, entry, modal) {
    removeBtn.onclick = async () => {
      if (!confirm('Remove this entry?')) return;
      removeBtn.disabled = true;
      removeBtn.textContent = '⏳';
      try {
        const mutation = `
          mutation ($id: Int) {
            DeleteMediaListEntry(id: $id) { deleted }
          }`;
        await this.plugin.requestQueue.add(() =>
          requestUrl({
            url: 'https://graphql.anilist.co',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.plugin.settings.accessToken}`
            },
            body: JSON.stringify({ query: mutation, variables: { id: entry.id } })
          })
        );
        // close modal & refresh view
        document.body.removeChild(modal);
        this.plugin.clearSingleEntryCache(
  entry.media.id,
  this.plugin.settings.defaultUsername || config.username,
  config.mediaType
);

        // trigger re-render of the block that owns this entry
        const parentContainer = document.querySelector('.zoro-container');
        if (parentContainer) {
          const block = parentContainer.closest('.markdown-rendered')?.querySelector('code');
          if (block) {
            this.plugin.processZoroCodeBlock(block.textContent, parentContainer, {});
          }
        }
        new Notice('✅ Removed');
      } catch (e) {
        new Notice('❌ Could not remove');
      }
    };
  }

  setupModalInteractions(modal, overlay, onCancel) {
    overlay.onclick = () => {
      onCancel();
      document.body.removeChild(modal);
    };
  }

  createEscapeListener(onCancel, modal, saveFunction) {
    return function escListener(e) {
      if (e.key === 'Escape') {
        onCancel();
        document.body.removeChild(modal);
        document.removeEventListener('keydown', escListener);
      }
      if (e.key === 'Enter' && e.ctrlKey) {
        saveFunction();
      }
    };
  }

  async setFavoriteStatus(entry, favBtn) {
    try {
      const query = `
        query ($mediaId: Int) {
          Media(id: $mediaId) { 
            isFavourite 
            type
          }
        }`;
      const res = await this.plugin.requestQueue.add(() =>
        requestUrl({
          url: 'https://graphql.anilist.co',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.plugin.settings.accessToken}`
          },
          body: JSON.stringify({ query, variables: { mediaId: entry.media.id } })
        })
      );
      const mediaData = res.json.data?.Media;
      const fav = mediaData?.isFavourite;
      favBtn.textContent = fav ? '❤️' : '🤍';
      
      // Store the media type for later use
      favBtn.dataset.mediaType = mediaData?.type;
    } catch (e) {
      console.warn('Could not fetch favorite', e);
    }
  }

  async toggleFavorite(entry, favBtn) {
    favBtn.disabled = true;
    favBtn.textContent = '⏳';
    
    try {
      // Use the stored media type, or fall back to detection
      let mediaType = favBtn.dataset.mediaType;
      if (!mediaType) {
        // Fallback detection - check for type field first, then episodes
        mediaType = entry.media.type || (entry.media.episodes ? 'ANIME' : 'MANGA');
      }
      
      const isAnime = mediaType === 'ANIME';
      
      const mutation = `
        mutation ToggleFav($animeId: Int, $mangaId: Int) {
          ToggleFavourite(animeId: $animeId, mangaId: $mangaId) {
            anime {
              nodes {
                id
              }
            }
            manga {
              nodes {
                id
              }
            }
          }
        }`;
        
      // Only include the relevant ID, don't pass null values
      const variables = {};
      if (isAnime) {
        variables.animeId = entry.media.id;
      } else {
        variables.mangaId = entry.media.id;
      }

      const res = await this.plugin.requestQueue.add(() =>
        requestUrl({
          url: 'https://graphql.anilist.co',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.plugin.settings.accessToken}`
          },
          body: JSON.stringify({ query: mutation, variables })
        })
      );
      
      if (res.json.errors) {
        new Notice(`API Error: ${res.json.errors[0].message}`, 8000);
        console.error('AniList API Error:', res.json.errors);
        throw new Error(res.json.errors[0].message);
      }
      
      // Check if the media is now in favorites by looking at the response
      const toggleResult = res.json.data?.ToggleFavourite;
      let isFav = false;
      
      if (isAnime && toggleResult?.anime?.nodes) {
        isFav = toggleResult.anime.nodes.some(node => node.id === entry.media.id);
      } else if (!isAnime && toggleResult?.manga?.nodes) {
        isFav = toggleResult.manga.nodes.some(node => node.id === entry.media.id);
      }
      
      favBtn.textContent = isFav ? '❤️' : '🤍';
      new Notice(`${isFav ? 'Added to' : 'Removed from'} favorites!`, 3000);
      
    } catch (e) {
      new Notice(`❌ Error: ${e.message || 'Unknown error'}`, 8000);
      console.error('Favorite toggle error:', e);
    } finally {
      favBtn.disabled = false;
    }
  }

  // Save logic
  async trySave(entry, onSave, saveBtn, statusSelect, scoreInput, progressInput, modal, escListener, closeModal) {
    if (this.saving) return;
    this.saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    const scoreVal = parseFloat(scoreInput.value);
    if (scoreInput.value && (isNaN(scoreVal) || scoreVal < 0 || scoreVal > 10)) {
      alert("⚠ Score must be between 0 and 10.");
      this.resetSaveBtn(saveBtn);
      return;
    }
    try {
      await onSave({
        status: statusSelect.value,
        score: scoreInput.value === '' ? null : scoreVal,
        progress: parseInt(progressInput.value) || 0
      });
      this.plugin.clearSingleEntryCache(
        entry.media.id,
        this.plugin.settings.authUsername || this.plugin.settings.defaultUsername,
        entry.media.type
      );
      
      closeModal();
    } catch (err) {
      alert(`❌ Failed to save: ${err.message}`);
    }
    this.resetSaveBtn(saveBtn);
  }

  resetSaveBtn(saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
    this.saving = false;
  }
}
// Prompt
class Prompt {
  constructor(plugin) {
    this.plugin = plugin;
  }

  createAuthenticationPrompt() {
    // Create modal wrapper
    const modal = document.createElement('div');
    modal.className = 'zoro-edit-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Authentication Required');

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'zoro-modal-overlay';

    // Modal content container
    const content = document.createElement('div');
    content.className = 'zoro-modal-content auth-prompt';

    // Title
    const title = document.createElement('h3');
    title.className = 'zoro-auth-title';
    title.textContent = '🔐 Authentication Required';

    // Message
    const message = document.createElement('p');
    message.className = 'zoro-auth-message';
    
    message.textContent = 'You need to authenticate with AniList to edit your anime/manga entries. This will allow you to update your progress, scores, and status directly from Obsidian.';

    // Feature list
    const featuresDiv = document.createElement('div');
    featuresDiv.className = 'zoro-auth-features';

    const featuresTitle = document.createElement('h4');
    featuresTitle.className = 'zoro-auth-features-title';
    featuresTitle.textContent = 'Features after authentication:';

    const featuresList = document.createElement('ul');
    featuresList.className = 'zoro-auth-feature-list';

    const features = [
      'Edit progress, scores, and status',
      'Access private lists and profiles',
      'Quick progress buttons (+1, -1, Complete)',
      'Auto-detect your username',
      'Real-time updates'
    ];

    features.forEach(feature => {
      const li = document.createElement('li');
      li.textContent = feature;
      featuresList.appendChild(li);
    });

    featuresDiv.appendChild(featuresTitle);
    featuresDiv.appendChild(featuresList);

    // Buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'zoro-modal-buttons';

    const authenticateBtn = document.createElement('button');
    authenticateBtn.className = 'zoro-auth-button';
    
    authenticateBtn.textContent = '🔑 Authenticate';
    authenticateBtn.onclick = () => {
      closeModal();
      this.plugin.app.setting.open();
      this.plugin.app.setting.openTabById(this.plugin.manifest.id);
      new Notice('📝 Please use optional login to authenticate');
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'zoro-cancel-button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => closeModal();

    buttonContainer.appendChild(authenticateBtn);
    buttonContainer.appendChild(cancelBtn);

    // Build modal
    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(featuresDiv);
    content.appendChild(buttonContainer);

    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Focus and Esc key handling
    authenticateBtn.focus();
  this.plugin.addGlobalListener(document, 'keydown', handleKeyDown);


    overlay.onclick = closeModal;

    function closeModal() {
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      document.removeEventListener('keydown', handleKeyDown);
    }

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    }
  }
}
// Export
class Export {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async exportUnifiedListsToCSV() {
    // decide which username to use
    let username = this.plugin.settings.authUsername;
    if (!username) username = this.plugin.settings.defaultUsername;
    if (!username) {
      new Notice('Set a default username in settings first.', 4000);
      return;
    }

    const useAuth = !!this.plugin.settings.accessToken;
    const query = `
      query ($userName: String) {
        MediaListCollection(userName: $userName, type: ANIME) {
          lists {
            name
            entries {
              status progress score(format: POINT_10_DECIMAL) repeat
              startedAt { year month day } completedAt { year month day }
              media {
                id type format
                title { romaji english native }
                episodes chapters volumes
                startDate { year month day } endDate { year month day }
                averageScore genres
                studios(isMain: true) { nodes { name } }
              }
            }
          }
        }
      }
    `;

    new Notice(`${useAuth ? '📥 Full' : '📥 Public'} export started…`, 4000);
  const progress = this.createProgressNotice('📊 Exporting… 0 %');
    const fetchType = async type => {
      const headers = { 'Content-Type': 'application/json' };
      if (useAuth) {
        await this.plugin.auth.ensureValidToken();
        headers['Authorization'] = `Bearer ${this.plugin.settings.accessToken}`;
      }

      const res = await this.plugin.requestQueue.add(() =>
        requestUrl({
          url: 'https://graphql.anilist.co',
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: query.replace('type: ANIME', `type: ${type}`),
            variables: { userName: username }
          })
        })
      );
       const percent = type === 'ANIME' ? 50 : 100;
     this.updateProgressNotice(progress, `📊 Exporting… ${percent} %`);
      return res.json.data?.MediaListCollection?.lists || [];
    };

    const [animeLists, mangaLists] = await Promise.all([fetchType('ANIME'), fetchType('MANGA')]);
    const lists = [...animeLists, ...mangaLists];

    if (!lists.flatMap(l => l.entries).length) {
      new Notice('No lists found (private or empty).', 4000);
      return;
    }

    const rows = [];
    const headers = [
      'ListName', 'Status', 'Progress', 'Score', 'Repeat',
      'StartedAt', 'CompletedAt', 'MediaID', 'Type', 'Format',
      'TitleRomaji', 'TitleEnglish', 'TitleNative',
      'Episodes', 'Chapters', 'Volumes',
      'MediaStart', 'MediaEnd', 'AverageScore', 'Genres', 'MainStudio', 'URL'
    ];
    rows.push(headers.join(','));

    for (const list of lists) {
      for (const e of list.entries) {
        const m = e.media;
        const row = [
          list.name, e.status, e.progress ?? 0, e.score ?? '', e.repeat ?? 0,
          this.dateToString(e.startedAt), this.dateToString(e.completedAt),
          m.id, m.type, m.format,
          this.csvEscape(m.title.romaji), this.csvEscape(m.title.english), this.csvEscape(m.title.native),
          m.episodes ?? '', m.chapters ?? '', m.volumes ?? '',
          this.dateToString(m.startDate), this.dateToString(m.endDate),
          m.averageScore ?? '', this.csvEscape((m.genres || []).join(';')),
          this.csvEscape(m.studios?.nodes?.[0]?.name || ''),
          this.csvEscape(this.plugin.getZoroUrl(m.id, m.type))
        ];
        rows.push(row.join(','));
      }
    }

    const csv = rows.join('\n');
    const suffix = useAuth ? '' : '_PUBLIC';
    const fileName = `AniList_${username}${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
    await this.plugin.app.vault.create(fileName, csv);
    new Notice(`✅ CSV saved to vault: ${fileName}`, 4000);
    await this.plugin.app.workspace.openLinkText(fileName, '', false);
  }

  /* ---------- helpers ---------- */
  dateToString(dateObj) {
    if (!dateObj || !dateObj.year) return '';
    return `${dateObj.year}-${String(dateObj.month || 0).padStart(2, '0')}-${String(dateObj.day || 0).padStart(2, '0')}`;
  }

  csvEscape(str = '') {
    if (typeof str !== 'string') str = String(str);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
  
  // main.js – inside Export class
createProgressNotice(message) {
  // Keep the notice reference so we can update it
  return new Notice(message, 0); // 0 = never auto-dismiss
}

updateProgressNotice(notice, message) {
  // Dismiss old notice and show new one (Obsidian replaces in-place)
  notice.hide();
  return new Notice(message, 0);
}

finishProgressNotice(notice, message) {
  notice.hide();
  new Notice(message, 4000); // auto-dismiss after 4 s
}

}
// Sample
class Sample {
  constructor(plugin) {
    this.plugin = plugin;
  }
  async createSampleNotes() {
    try {
      let successCount = 0;
      const errorMessages = [];

      const firstNoteTitle  = 'Anime Dashboard';
      const firstNoteContent = `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

# 👀 Watching:
\`\`\`zoro
listType: CURRENT
mediaType: ANIME
\`\`\`

# 📝 Planning:
\`\`\`zoro
listType: PLANNING
mediaType: ANIME
\`\`\`

# 🌀 Repeating:
\`\`\`zoro
listType: REPEATING
mediaType: ANIME
\`\`\`

# ⏸️ On Hold:
\`\`\`zoro
listType: PAUSED
mediaType: ANIME
\`\`\`

# 🏁 Completed:
\`\`\`zoro
listType: COMPLETED
mediaType: ANIME
\`\`\`

# 🗑️ Dropped:
\`\`\`zoro
listType: DROPPED
mediaType: ANIME
\`\`\`

# 📊 Stats:
\`\`\`zoro
type: stats
\`\`\` 
`;

      const secondNoteTitle  = 'Manga Dashboard';
      const secondNoteContent = `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

# 📖 Reading:
\`\`\`zoro
listType: CURRENT
mediaType: MANGA
\`\`\`

# 📝 Planning:
\`\`\`zoro
listType: PLANNING
mediaType: MANGA
\`\`\`

# 🌀 Repeating:
\`\`\`zoro
listType: REPEATING
mediaType: MANGA
\`\`\`

# ⏸️ On Hold:
\`\`\`zoro
listType: PAUSED
mediaType: MANGA
\`\`\`

# 🏁 Completed:
\`\`\`zoro
listType: COMPLETED
mediaType: MANGA
\`\`\`

# 🗑️ Dropped:
\`\`\`zoro
listType: DROPPED
mediaType: MANGA
\`\`\`

# 📊 Stats:
\`\`\`zoro
type: stats
\`\`\` 
`;

      const notes = [
        { title: firstNoteTitle, content: firstNoteContent },
        { title: secondNoteTitle, content: secondNoteContent }
      ];

      for (const note of notes) {
        const filePath = `${note.title}.md`;
        const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (existing) {
          errorMessages.push(`"${note.title}" already exists`);
          continue;
        }

        await this.plugin.app.vault.create(filePath, note.content);
        successCount++;
      }

      if (successCount) {
        new Notice(`Created ${successCount} note${successCount > 1 ? 's' : ''}`, 4000);
        const first = this.plugin.app.vault.getAbstractFileByPath(`${firstNoteTitle}.md`);
        if (first) await this.plugin.app.workspace.openLinkText(firstNoteTitle, '', false);
      }
      if (errorMessages.length) new Notice(`Note: ${errorMessages.join(', ')}`, 5000);

    } catch (err) {
      console.error('Error creating notes:', err);
      new Notice(`Failed to create notes: ${err.message}`, 5000);
    }
  }

  async createSampleFolders() {
  const { vault, workspace } = this.plugin.app;
  const dashboards = [
    {
      folder: 'Anime Dashboard',
      notes: [
        {
          name: 'Watching',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: CURRENT
mediaType: ANIME
\`\`\``
        },
        {
          name: 'Planning',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: PLANNING
mediaType: ANIME
\`\`\``
        },
        {
          name: 'Repeating',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: REPEATING
mediaType: ANIME
\`\`\``
        },
        {
          name: 'On Hold',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: PAUSED
mediaType: ANIME
\`\`\``
        },
        {
          name: 'Completed',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: COMPLETED
mediaType: ANIME
\`\`\``
        },
        {
          name: 'Dropped',
          content: `\`\`\`zoro-search
mediaType: ANIME
\`\`\`

\`\`\`zoro
listType: DROPPED
mediaType: ANIME
\`\`\``
        },
        {
          name: 'Stats',
          content: `\`\`\`zoro
type: stats
\`\`\``
        }
      ]
    },
    {
      folder: 'Manga Dashboard',
      notes: [
        {
          name: 'Reading',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: CURRENT
mediaType: MANGA
\`\`\``
        },
        {
          name: 'Planning',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: PLANNING
mediaType: MANGA
\`\`\``
        },
        {
          name: 'Repeating',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: REPEATING
mediaType: MANGA
\`\`\``
        },
        {
          name: 'On Hold',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: PAUSED
mediaType: MANGA
\`\`\``
        },
        {
          name: 'Completed',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: COMPLETED
mediaType: MANGA
\`\`\``
        },
        {
          name: 'Dropped',
          content: `\`\`\`zoro-search
mediaType: MANGA
\`\`\`

\`\`\`zoro
listType: DROPPED
mediaType: MANGA
\`\`\``
        },
        {
          name: 'Stats',
          content: `\`\`\`zoro
type: stats
\`\`\``
        }
      ]
    }
  ];

  for (const { folder, notes } of dashboards) {
    try {
      // Create folder if missing
      if (!vault.getAbstractFileByPath(folder)) {
        await vault.createFolder(folder);
      }
      // Create notes within it
      for (const { name, content } of notes) {
        const path = `${folder}/${name}.md`;
        if (!vault.getAbstractFileByPath(path)) {
          await vault.create(path, content);
        }
      }
      // Open the first note
      await workspace.openLinkText(notes[0].name, folder, false);
    } catch (err) {
      console.error(`[Zoro] Error creating "${folder}":`, err);
      new Notice(`❌ Failed creating ${folder}: ${err.message}`, 5000);
    }
  }

  new Notice('✅ Dashboards generated!', 4000);
}
}

// Settings
class ZoroSettingTab extends PluginSettingTab { 
  constructor(app, plugin) { 
    super(app, plugin); 
    this.plugin = plugin; 
  }
  

  display() { 
    
    
    const { containerEl } = this;
    
    containerEl.empty()
    
        const section = (title, startOpen = false) => {
      const head = containerEl.createEl('h2', { text: title });
      head.style.cursor = 'pointer';
      head.style.userSelect = 'none';
      head.style.margin = '1.2em 0 0.4em 0';
      const body = containerEl.createDiv();
      body.style.marginLeft = '1em';
      body.style.display = startOpen ? 'block' : 'none';
      head.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
      });
      return body;
    };

// variables For headers
        const Account  = section('👤 Account', true);
    const Display = section('📺 Display');
    const Theme = section('🌌 Theme');
    const Guide = section('🧭 Guide');
    const Data = section('📤 Data');
     const More = section('✨  More');
    const Exp = section('🚧 Experimental');
    const About = section('ℹ️ About');
    
    

    
    new Setting(Account)
      .setName('🆔 Username')
      .setDesc("Lets you access your public profile and stats — that's it" )
      .addText(text => text
        .setPlaceholder('Enter your AniList username')
        .setValue(this.plugin.settings.defaultUsername)
        .onChange(async (value) => {
          this.plugin.settings.defaultUsername = value.trim();
          await this.plugin.saveSettings();
        }));
        
        // Dynamic Authentication button

const authSetting = new Setting(
  Account)
  .setName('🔓 Optional Login')
  .setDesc('Lets you peek at your private profile and actually change stuff.');

authSetting.addButton(button => {
  this.authButton = button;
  this.updateAuthButton();
  
  button.onClick(async () => {
    await this.handleAuthButtonClick();
  });
});

    new Setting(Display)
      .setName('🧊 Layout')
      .setDesc('Choose the default layout for media lists')
      .addDropdown(dropdown => dropdown
        .addOption('card', 'Card Layout')
        .addOption('table', 'Table Layout')
        .setValue(this.plugin.settings.defaultLayout)
        .onChange(async (value) => {
          this.plugin.settings.defaultLayout = value;
          await this.plugin.saveSettings();
        }));
        
        new Setting(Display)
      .setName('🔲 Grid Columns')
      .setDesc('Number of columns in card grid layout')
      .addSlider(slider => slider
        .setLimits(1, 6, 1)
        .setValue(this.plugin.settings.gridColumns)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.gridColumns = value;
          await this.plugin.saveSettings();
        }));

    new Setting(More)
      .setName('🌆 Cover')
      .setDesc('Display cover images for anime/manga')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCoverImages)
        .onChange(async (value) => {
          this.plugin.settings.showCoverImages = value;
          await this.plugin.saveSettings();
        }));

    new Setting(More)
      .setName('⭐ Ratings')
      .setDesc('Display user ratings/scores')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showRatings)
        .onChange(async (value) => {
          this.plugin.settings.showRatings = value;
          await this.plugin.saveSettings();
        }));

    new Setting(More)
      .setName('📈 Progress')
      .setDesc('Display progress information')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showProgress)
        .onChange(async (value) => {
          this.plugin.settings.showProgress = value;
          await this.plugin.saveSettings();
        }));

    new Setting(More)
      .setName('🎭 Genres')
      .setDesc('Display genre tags')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showGenres)
        .onChange(async (value) => {
          this.plugin.settings.showGenres = value;
          await this.plugin.saveSettings();
        }));

    new Setting(More) // or Display section
  .setName('⏳ Loading Icon')
  .setDesc('Show loading animation during API requests')
  .addToggle(toggle => toggle
    .setValue(this.plugin.settings.showLoadingIcon)
    .onChange(async (value) => {
      this.plugin.settings.showLoadingIcon = value;
      await this.plugin.saveSettings();
    }));


    
        
/* ---- Unified Export button (always shown) ---- */
new Setting(Data)
.setName('🧾 Export your data')
  .setDesc("Everything you've watched, rated, and maybe ghosted — neatly exported into a CSV.")
  .addButton(btn => btn
    .setButtonText('Export')
    .setClass('mod-cta')
    .onClick(async () => {
      try {
        await this.plugin.export.exportUnifiedListsToCSV();
      } catch (err) {
        new Notice(`❌ Export failed: ${err.message}`, 6000);
      }
    })
  );
  
  


new Setting(Theme)
  .setName('Select Theme')
  .setDesc('Pick a custom CSS file from the themes folder')
  .addDropdown(async dropdown => {
    // Populate
    dropdown.addOption('', 'default');
    const themes = await this.plugin.theme.getAvailableThemes();
    themes.forEach(t => dropdown.addOption(t, t));

    // Pre-select saved value
    dropdown.setValue(this.plugin.settings.theme);

    // On change: apply + save
    dropdown.onChange(async value => {
      this.plugin.settings.theme = value;
      await this.plugin.saveSettings();
      await this.plugin.theme.applyTheme(value);
    });
  });

new Setting(Guide)
  .setName('⚡ Sample Folders')
  .setDesc('Builds two folders for you — anime and manga — with everything pre-filled: notes, lists, search, stats. (Recommended)')
  .addButton(button =>
    button
      .setButtonText('Create Sample Folders')
      .onClick(async () => {
       await this.plugin.sample.createSampleFolders();
      })
  );
new Setting(Guide)
    .setName('🍜 Sample Notes')
    .setDesc('Builds two notes for you — anime and manga — with everything pre-filled: lists, search, stats. Like instant noodles, but for your library.')
    .addButton(button => button
      .setButtonText('Create Note')
      .setTooltip('Click to create sample notes in your vault')
      .onClick(async () => {
        await this.plugin.sample.createSampleNotes();
        this.display();
      })
    );
    
    new Setting(Guide)
     .setName('🗝️ Need a Client ID?')
    .setDesc('Click here to open the step-by-step guide for generating your AniList Client ID & Secret. Takes less than a minute—no typing, just copy and paste.')
      .addButton(button => button
        .setButtonText('Setup Guide')
        .onClick(() => {
          window.open('https://github.com/zara-kasi/zoro/blob/main/Docs/anilist-auth-setup.md', '_blank');
        }));
        
        
        new Setting(About)
  .setName('Author')
  .setDesc(this.plugin.manifest.author);
  new Setting(About)
  .setName('Version')
  .setDesc(this.plugin.manifest.version);
new Setting(About)
  .setName('Privacy')
  .setDesc('Zoro only talks to the AniList API to fetch & update your media data. Nothing else is sent or shared—your data stays local.');

new Setting(About)
  .setName('GitHub')
  .setDesc('Get more info or report an issue.')
  .addButton(button =>
    button
    .setClass('mod-cta')
      .setButtonText('Open GitHub')
      .onClick(() => {
        window.open('https://github.com/zara-kasi/zoro', '_blank');
      })
  );
  



  }
  //  Dynamic Update of Auth button
updateAuthButton() {
  if (!this.authButton) return;

  const { settings } = this.plugin;

  if (!settings.clientId) {
    this.authButton.setButtonText('Enter Client ID');
    this.authButton.removeCta();
  } else if (!settings.clientSecret) {
    this.authButton.setButtonText('Enter Client Secret');
    this.authButton.removeCta();
  } else if (!settings.accessToken) {
    this.authButton.setButtonText('Authenticate Now');
    this.authButton.setCta();
  } else {
    this.authButton.setButtonText('Sign Out');
    this.authButton.setWarning().removeCta();
  }
}

async handleAuthButtonClick() {
  const { settings } = this.plugin;

  if (!settings.clientId) {
    const modal = new ClientIdModal(this.app, async (clientId) => {
      if (clientId?.trim()) {
        settings.clientId = clientId.trim();
        await this.plugin.saveSettings();
        this.updateAuthButton();
      }
    });
    modal.open();
  } else if (!settings.clientSecret) {
    const modal = new ClientSecretModal(this.app, async (clientSecret) => {
      if (clientSecret?.trim()) {
        settings.clientSecret = clientSecret.trim();
        await this.plugin.saveSettings();
        this.updateAuthButton();
      }
    });
    modal.open();
  } else if (!settings.accessToken) {
    await this.plugin.auth.loginWithFlow();
    this.updateAuthButton(); // refresh after login completes
  } else {
    if (confirm('⚠️ Are you sure you want to sign out?')) { 
    await this.plugin.auth.logout();
    this.updateAuthButton(); // refresh after logout
  }
  }
}


}
module.exports = {
  default: ZoroPlugin,
};

