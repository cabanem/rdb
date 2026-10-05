/**
 * @file 03_Workato_Services.gs
 * @desc
 */

/**
 * @class
 */
class WorkatoClient {
  constructor() {
    const apiConfig = AppConfig.get().API;
    const verbose = AppConfig.get().VERBOSE;

    // Initialize external library dependency
    this.client = WorkatoLib.newClient(
      apiConfig.TOKEN,
      apiConfig.BASE_URL,
      {
        verbose: verbose,
        maxRetries: apiConfig.MAX_RETRIES,
        dryRun: false,
        perPage: apiConfig.PER_PAGE
      }
    );
  }

  get(endpoint) {
    return this.client.get(endpoint);
  }
  fetchPaginated(resourcePath) {
    return this.client.fetchPaginated(resourcePath);
  }
}

/**
 * @class
 * @classdesc Service responsible for fetching high-level Workato entities.
 * * Encapsulates logic for Projects, Recipes, Properties, and Folder Recursion.
 */
class InventoryService {
  /**
   * @param {WorkatoClient} client - An initialized API client instance.
   */
  constructor(client) {
    this.client = client;
    this.config = AppConfig.get();
  }
  /**
   * Fetches all available projects.
   * @returns {Array<Object>} List of project objects.
   */
  getProjects() { return this.client.fetchPaginated('projects'); }
  /**
   * Fetches all recipes.
   * @returns {Array<Object>} List of recipe objects.
   */
  getRecipes() { return this.client.fetchPaginated('recipes'); }
  /**
   * Fetches workspace properties.
   * * Safely handles errors (e.g., 403 Forbidden) if the user lacks permissions.
   * @returns {Array<Object>} List of property objects, or empty array on error.
   */
  getProperties() {
    try {
      return this.client.fetchPaginated('properties');
    } catch (e) {
      console.warn(`SKIPPING PROPERTIES: The API rejected the request (${e.message}).`);
      return [];
    }
  }
  /**
   * Fetches all lookup tables.
   * @returns {Array<object>} List of table objects.
   */
  getLookupTables() {
    return this._fetchPaginatedNormalized_('lookup_tables');
  }
  /**
   * Fetches all data tables.
   * @returns {Array<object>} List of table objects.
   */
  getDataTables() {
    return this._fetchPaginatedNormalized_('data_tables');
  }
  /**
   * Fetches the current authenticated user details.
   * @returns {Object|null} User profile object or null on failure.
   */
  getCurrentUser() {
    try {
      return this.client.get('users/me');
    } catch (e) {
      return null;
    }
  }
  /**
   * Recursively fetches all folders using a Hybrid Sync strategy.
   * 1. Scans Project Roots (folders?project_id=X)
   * 2. Scans Workspace Root (folders)
   * 3. Recursively scans children via queue (folders?parent_id=Y)
   * * @param {Array<Object>} projects - List of projects to seed the search.
   * @returns {Array<Object>} Comprehensive list of all folder objects.
   */
  getFoldersRecursive(projects) {
    let allFolders = [];
    let queue = [];
    let qIndex = 0; // FIFO without O(n) shift()
    let processedIds = new Set();
    const MAX_CALLS = this.config.API.MAX_CALLS;

    AppLog.verbose(`Starting folder sync...`);

    // PHASE 1: Project Roots
    for (const project of projects) {
      // Note: We use the raw client.get here because these are single batch checks, not full pagination loops
      try {
        const potentialRoots = this._fetchFolderBatch(`folders?project_id=${project.id}`);
        const rootFolder = potentialRoots.find(f => f.project_id === project.id && f.is_project === true);

        if (rootFolder && !processedIds.has(rootFolder.id)) {
          allFolders.push(rootFolder);
          processedIds.add(rootFolder.id);
          queue.push(rootFolder.id);
        }
      } catch (e) {
        console.warn(`Failed to fetch root for project ${project.id}: ${e.message}`);
      }
    }

    // PHASE 2: Home Folders
    let globalFolders = [];
    try {
      // Prefer complete root set; fall back to legacy single-batch on error
      globalFolders = this.client.fetchPaginated('folders');
    } catch (e) {
      globalFolders = this._fetchFolderBatch('folders');
    }
    globalFolders.forEach(f => {
      if (!processedIds.has(f.id)) {
        allFolders.push(f);
        processedIds.add(f.id);
        queue.push(f.id);
      }
    });

    // PHASE 3: Recursion
    let safetyCounter = 0;
    while (qIndex < queue.length && safetyCounter < MAX_CALLS) {
      let parentId = queue[qIndex++];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `folders?parent_id=${parentId}&page=${page}&per_page=${this.config.API.PER_PAGE}`;
        const items = this._fetchFolderBatch(url);

        if (items.length > 0) {
          const newItems = items.filter(f => !processedIds.has(f.id));
          if (newItems.length > 0) {
            allFolders = allFolders.concat(newItems);
            newItems.forEach(f => {
              processedIds.add(f.id);
              queue.push(f.id);
            });
          }

          if (items.length < this.config.API.PER_PAGE) hasMore = false;
          else page++;
        } else {
          hasMore = false;
        }
        safetyCounter++;
      }

      if (safetyCounter % 20 === 0) Utilities.sleep(50);
    }

    console.log(`Sync complete. Found ${allFolders.length} total folders.`);
    return allFolders;
  }

  // --- INTERNALS ---------------------------------------------------------------------------------------
  /**
   * Helper to fetch a single batch of folders and normalize the response.
   * Accounts for API inconsistencies where folders may return as array or object wrapper.
   * * @param {string} endpoint - The API endpoint to fetch.
   * @returns {Array<Object>} Array of folder objects (empty if error).
   * @private
   */
  _fetchFolderBatch(endpoint) {
    try {
      const json = this.client.get(endpoint);
      return Array.isArray(json) ? json : (json.items || json.result || []);
    } catch (e) {
      // Original script returned empty array on error for folder batches
      return [];
    }
  }
  _fetchPaginatedNormalized_(resourcePath) {
    // 1) Prefer library pagination if it works
    try {
      const res = this.client.fetchPaginated(resourcePath);
      const arr = this._normalizeListResponse_(res);
      if (Array.isArray(arr) && arr.length > 0) return arr; // empty to fall through to manual get paging
    } catch (e) {
      // fall through to manual paging
    }

    // 2) Manual paging (handles endpoints that wrap results under "data")
    const out = [];
    const perPage = Number(this.config.API.PER_PAGE || 100);
    const maxCalls = Number(this.config.API.MAX_CALLS || 500);

    let page = 1;
    let safety = 0;
    while (safety < maxCalls) {
      try {
        const endpoint = `${resourcePath}?page=${page}&per_page=${perPage}`;
        const json = this.client.get(endpoint);
        const items = this._normalizeListResponse_(json);
        if (!items || items.length === 0) break;
        out.push(...items);
        if (items.length < perPage) break;
        page++;
        safety++;
        if (safety % 10 === 0) Utilities.sleep(50);
      } catch (e) {
        console.warn(`SKIPPING ${resourcePath.toUpperCase()}: ${e.message}`);
        break;
      }
    }
    return out;
  }
  _normalizeListResponse_(json) {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== 'object') return [];
    // data tables list uses { data: [...] }
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.items)) return json.items;
    if (Array.isArray(json.result)) return json.result;
    return [];
  }
}
/**
 * @class
 * @classdesc Unified service for deep inspection of recipe logic / code.
 * Merges functionality from historical DependencyService and LogicService.
 * RecipeAnalyzer: 1zQz8lK_00xJiyVweBiNUfhr54HqAGY0isdck0lQCYyr134Xmm7fx_ahW
 */
class RecipeAnalyzerService {
  /**
   * @param {WorkatoClient} client
   */
  /**
   * @param {WorkatoClient} client
   * @param {{ strict?: boolean }} [options]  strict: a failed recipe fetch or code parse THROWS instead of
   *   warning and contributing zero edges. Required by anything that derives an order or a table from the
   *   graph (a silently missing recipe makes the output wrong without an error). Default false: the
   *   inventory views prefer a partial picture over no picture.
   */
  constructor(client, options = {}) {
    // 1. Dependency injection (pass client to new lib)
    this.engine = WorkatoGraphLib.newAnalyzer(client, {
      MERMAID_LABEL_MAX: AppConfig.get().CONSTANTS.MERMAID_LABEL_MAX,
      STRICT: !!options.strict
    });
  }
  /** Engine constants (RECIPE_PROVIDERS etc.) for callers that classify recipe code. */
  get CONSTANTS() { return this.engine.CONSTANTS; }

  // ----- Delegate methods -------------------------------------------------
  getDependencies(recipeId) {
    return this.engine.getDependencies(recipeId);
  }
  getCallEdges(recipeId) {
    return this.engine.getCallEdges(recipeId);
  }
  parseLogicRows(recipe) {
    return this.engine.parseLogicRows(recipe);
  }
  getRecipeDetails(recipeId) {
    return this.engine.getRecipeDetails(recipeId);
  }
  primeCache(recipes) {
    return this.engine.primeCache(recipes);
  }
  buildGraphPack(rootId, options) {
    return this.engine.buildGraphPack(rootId, options);
  }
  /** Raw steps matching a predicate, with step_path / branch_context. Requires WorkatoGraphLib >= 1.1.0. */
  collectSteps(recipeId, predicate) {
    return this.engine.collectSteps(recipeId, predicate);
  }
  /** Every datapill reference inside a value (string / array / object). Requires WorkatoGraphLib >= 1.1.0. */
  extractPillRefs(value) {
    return this.engine.extractPillRefs(value);
  }
}
