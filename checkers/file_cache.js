/**
 * File Cache Manager
 * Caches parsed file data to avoid redundant parsing
 */

const FileCache = {
  cache: new Map(),
  
  /**
   * Generate cache key from file
   */
  _generateKey(file) {
    return `${file.name}_${file.size}_${file.lastModified}`;
  },

  /**
   * Store parsed data in cache
   */
  set(file, parsedData, checkerType = 'default') {
    const key = this._generateKey(file);
    const cacheKey = `${checkerType}_${key}`;
    
    this.cache.set(cacheKey, {
      data: parsedData,
      timestamp: Date.now(),
      fileName: file.name,
      fileSize: file.size
    });
    
    console.log(`[FileCache] Cached ${checkerType} data for ${file.name}`);
    return parsedData;
  },

  /**
   * Retrieve parsed data from cache
   */
  get(file, checkerType = 'default') {
    const key = this._generateKey(file);
    const cacheKey = `${checkerType}_${key}`;
    
    const cached = this.cache.get(cacheKey);
    
    if (cached) {
      console.log(`[FileCache] Cache hit for ${file.name} (${checkerType})`);
      return cached.data;
    }
    
    console.log(`[FileCache] Cache miss for ${file.name} (${checkerType})`);
    return null;
  },

  /**
   * Check if file is cached
   */
  has(file, checkerType = 'default') {
    const key = this._generateKey(file);
    const cacheKey = `${checkerType}_${key}`;
    return this.cache.has(cacheKey);
  },

  /**
   * Clear specific file from cache
   */
  clear(file, checkerType = 'default') {
    if (file) {
      const key = this._generateKey(file);
      const cacheKey = `${checkerType}_${key}`;
      this.cache.delete(cacheKey);
      console.log(`[FileCache] Cleared cache for ${file.name} (${checkerType})`);
    } else {
      // Clear all cache
      this.cache.clear();
      console.log(`[FileCache] Cleared all cache`);
    }
  },

  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      totalEntries: this.cache.size,
      entries: []
    };
    
    this.cache.forEach((value, key) => {
      stats.entries.push({
        key,
        fileName: value.fileName,
        fileSize: value.fileSize,
        cachedAt: new Date(value.timestamp).toLocaleString(),
        ageMs: Date.now() - value.timestamp
      });
    });
    
    return stats;
  },

  /**
   * Remove old cache entries (older than maxAge milliseconds)
   */
  cleanup(maxAge = 3600000) { // Default: 1 hour
    const now = Date.now();
    let removed = 0;
    
    this.cache.forEach((value, key) => {
      if (now - value.timestamp > maxAge) {
        this.cache.delete(key);
        removed++;
      }
    });
    
    if (removed > 0) {
      console.log(`[FileCache] Cleaned up ${removed} old entries`);
    }
    
    return removed;
  },

  /**
   * Wrapper for parse functions with caching
   */
  async parseWithCache(file, parseFunction, checkerType = 'default') {
    // Check cache first
    const cached = this.get(file, checkerType);
    if (cached !== null) {
      return cached;
    }
    
    // Parse and cache
    console.log(`[FileCache] Parsing ${file.name} for ${checkerType}...`);
    const parsed = await parseFunction(file);
    this.set(file, parsed, checkerType);
    
    return parsed;
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.FileCache = FileCache;
  
  // Auto-cleanup old cache entries every 5 minutes
  setInterval(() => FileCache.cleanup(), 300000);
}
