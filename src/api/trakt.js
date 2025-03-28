const axios = require('axios');
const { pool } = require('../helpers/db');
const log = require('../helpers/logger');
const { addToQueueGET, addToQueuePOST } = require('../helpers/bottleneck_trakt');
const { safeRedisCall } = require('../helpers/redis');
const { parseCacheDuration } = require('../helpers/cache');

const TRAKT_BASE_URL = 'https://api.trakt.tv';
const TRAKT_API_VERSION = '2';
const TRAKT_API_KEY = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_REDIRECT_URI = `${process.env.BASE_URL}/callback`;

const makeGetRequest = (url, accessToken = null) => {
    const headers = {
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': TRAKT_API_KEY,
    };

    if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
    } else {
        log.debug(`No access token provided, making unauthenticated request.`);
    }

    const cacheKey = `trakt:GET:${accessToken || 'public'}:${url}`;

    return new Promise(async (resolve, reject) => {
        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            log.debug(`Cache hit for URL: ${url}`);
            return resolve(JSON.parse(cachedData));
        }

        addToQueueGET({
            fn: () => axios.get(url, { headers })
                .then(async (response) => {
                    log.debug(`API GET request successful for URL: ${url}`);

                    const cacheDuration = parseCacheDuration(process.env.TRAKT_CACHE_DURATION || '1d');
                    await safeRedisCall('set', cacheKey, JSON.stringify(response.data), 'EX', cacheDuration);

                    resolve(response.data);
                })
                .catch(error => {
                    if (error.response && error.response.status === 401) {
                        log.warn(`Unauthorized request (401) during API GET request for URL: ${url} - ${error.message}`);
                    } else {
                        log.error(`Error during API GET request for URL: ${url} - ${error.message}`);
                    }
                    reject(error);
                })
        });
    });
};

const makePostRequest = (url, data, accessToken = null) => {
    const headers = {
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': TRAKT_API_KEY,
        'Content-Type': 'application/json',
    };

    if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
    }

    const cacheKey = `trakt:POST:${accessToken || 'public'}:${url}:${JSON.stringify(data)}`;

    return new Promise(async (resolve, reject) => {
        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            log.debug(`Cache hit for POST URL: ${url}`);
            return resolve(JSON.parse(cachedData));
        }

        addToQueuePOST({
            fn: () => axios.post(url, data, { headers })
                .then(async (response) => {
                    log.debug(`API POST request successful for URL: ${url}`);

                    const cacheDuration = parseCacheDuration(process.env.TRAKT_CACHE_DURATION || '1d');
                    await safeRedisCall('set', cacheKey, JSON.stringify(response.data), 'EX', cacheDuration);

                    resolve(response.data);
                })
                .catch(error => {
                    log.error(`Error during API POST request for URL: ${url} - ${error.message}`);
                    reject(error);
                })
        });
    });
};

const exchangeCodeForToken = async (code) => {
    try {
        const response = await makePostRequest(`${TRAKT_BASE_URL}/oauth/token`, {
            code: code,
            client_id: TRAKT_API_KEY,
            client_secret: TRAKT_CLIENT_SECRET,
            redirect_uri: TRAKT_REDIRECT_URI,
            grant_type: 'authorization_code',
        });

        return response;
    } catch (error) {
        log.error(`Error exchanging authorization code for token: ${error.message}`);
        throw error;
    }
};

const fetchData = async (endpoint, params = {}, accessToken = null) => {
    const queryString = new URLSearchParams(params).toString();
    const url = `${TRAKT_BASE_URL}${endpoint}?${queryString}`;

    try {
        const data = await makeGetRequest(url, accessToken);
        log.debug(`Data successfully retrieved from URL: ${url}`);
        return data;
    } catch (error) {
        throw error;
    }
};

const refreshTraktToken = async (refreshToken) => {
    const payload = {
        refresh_token: refreshToken,
        client_id: TRAKT_API_KEY,
        client_secret: TRAKT_CLIENT_SECRET,
        redirect_uri: TRAKT_REDIRECT_URI,
        grant_type: 'refresh_token'
    };

    try {
        const data = await makePostRequest('https://api.trakt.tv/oauth/token', payload);
        log.debug('Token refreshed successfully');
        return data;
    } catch (error) {
        if (error.response) {
            log.error(`Failed to refresh token: ${JSON.stringify(error.response.data)}`);
        } else {
            log.error(`Failed to refresh token: ${error.message}`);
        }
        throw error;
    }
};

const updateTokensInDb = async (username, newAccessToken, newRefreshToken) => {
    await pool.query(
        'UPDATE trakt_tokens SET access_token = $1, refresh_token = $2 WHERE username = $3',
        [newAccessToken, newRefreshToken, username]
    );
};

const fetchUserHistory = async (username, type, accessToken) => {
    const endpoint = `/users/${username}/watched/${type}`;

    try {
        return await fetchData(endpoint, {}, accessToken);
    } catch (error) {
        if (error.response && error.response.status === 401) {
            throw new Error('token_expired');
        } else {
            throw error;
        }
    }
};

async function handleTraktHistory(parsedConfig, filteredResults, type) {
    const traktUsername = parsedConfig.traktUsername;
    const watchedEmoji = parsedConfig.watchedEmoji || '✔️';
    const fetchInterval = process.env.TRAKT_HISTORY_FETCH_INTERVAL || '24h';

    const dbType = type === 'movies' ? 'movie' : type === 'series' ? 'show' : type;

    const intervalInMs = (() => {
        const intervalValue = parseInt(fetchInterval.slice(0, -1), 10);
        const intervalUnit = fetchInterval.slice(-1);

        switch (intervalUnit) {
            case 'h':
                return intervalValue * 60 * 60 * 1000;
            case 'd':
                return intervalValue * 24 * 60 * 60 * 1000;
            default:
                throw new Error(`Invalid time unit in TRAKT_HISTORY_FETCH_INTERVAL: ${fetchInterval}`);
        }
    })();

    const result = await pool.query(
        `SELECT last_fetched_at FROM trakt_tokens WHERE username = $1`,
        [traktUsername]
    );

    const lastFetchedRow = result.rows[0];
    const lastFetchedAt = lastFetchedRow ? new Date(lastFetchedRow.last_fetched_at) : null;
    const now = new Date();

    if (!lastFetchedAt || (now - lastFetchedAt) >= intervalInMs) {
        try {
            const tokensResult = await pool.query(
                `SELECT access_token, refresh_token FROM trakt_tokens WHERE username = $1`,
                [traktUsername]
            );

            const tokensRow = tokensResult.rows[0];
            if (tokensRow) {
                let { access_token, refresh_token } = tokensRow;

                try {
                    const [movieHistory, showHistory] = await Promise.all([
                        fetchUserHistory(traktUsername, 'movies', access_token),
                        fetchUserHistory(traktUsername, 'shows', access_token)
                    ]);

                    await Promise.all([
                        saveUserWatchedHistory(traktUsername, movieHistory),
                        saveUserWatchedHistory(traktUsername, showHistory)
                    ]);
                } catch (error) {
                    if (error.message === 'token_expired') {
                        log.warn(`Token expired for user ${traktUsername}, refreshing token...`);

                        const newTokens = await refreshTraktToken(refresh_token);
                        access_token = newTokens.access_token;
                        refresh_token = newTokens.refresh_token;

                        await updateTokensInDb(traktUsername, newTokens.access_token, newTokens.refresh_token);

                        const [movieHistory, showHistory] = await Promise.all([
                            fetchUserHistory(traktUsername, 'movies', newTokens.access_token),
                            fetchUserHistory(traktUsername, 'shows', newTokens.access_token)
                        ]);

                        await Promise.all([
                            saveUserWatchedHistory(traktUsername, movieHistory),
                            saveUserWatchedHistory(traktUsername, showHistory)
                        ]);
                    } else {
                        throw error;
                    }
                }

                await pool.query(
                    `UPDATE trakt_tokens SET last_fetched_at = $1 WHERE username = $2`,
                    [now.toISOString(), traktUsername]
                );
            }
        } catch (error) {
            log.error(`Error fetching Trakt history for user ${traktUsername}: ${error.message}`);
        }
    }

    const traktIdsResult = await pool.query(
        `SELECT imdb_id FROM trakt_history WHERE username = $1 AND type = $2 AND imdb_id IS NOT NULL`,
        [traktUsername, dbType]
    );

    log.debug(`Fetching Trakt history for user ${traktUsername} with type ${dbType}. Result: ${traktIdsResult.rows.length} items found.`);
    const traktIds = traktIdsResult.rows.map(row => `${row.imdb_id}`);

    return filteredResults.map(content => {
        const contentId = `${content.id}`;
        if (traktIds.includes(contentId)) {
            content.name = `${watchedEmoji} ${content.name || content.title}`;
        }
        return content;
    });
}

const saveUserWatchedHistory = async (username, history) => {
    if (!history || history.length === 0) {
        log.warn(`No history to save for user ${username}.`);
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const item of history) {
            const media = item.movie || item.show;
            const mediaId = media.ids.imdb || media.ids.tmdb;
            const mediaType = item.movie ? 'movie' : 'show';
            const watchedAt = item.last_watched_at;
            const title = media.title;

            const historyResult = await client.query(
                `SELECT id FROM trakt_history WHERE username = $1 AND imdb_id = $2`,
                [username, media.ids.imdb]
            );

            if (historyResult.rows.length > 0) {
                await client.query(
                    `UPDATE trakt_history
                     SET watched_at = $1, title = $2, tmdb_id = $3, type = $4
                     WHERE id = $5`,
                    [watchedAt, title, media.ids.tmdb, mediaType, historyResult.rows[0].id]
                );
            } else {
                await client.query(
                    `INSERT INTO trakt_history (username, imdb_id, tmdb_id, type, watched_at, title)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [username, media.ids.imdb, media.ids.tmdb, mediaType, watchedAt, title]
                );
            }
        }

        await client.query('COMMIT');
        log.info(`History saved for user ${username}`);
    } catch (err) {
        await client.query('ROLLBACK');
        log.error(`Error committing transaction for user ${username}: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
};

const fetchUserProfile = async (accessToken) => {
    const endpoint = '/users/me';
    return await fetchData(endpoint, {}, accessToken);
};

async function lookupTraktId(tmdbId, type, accessToken) {
    const url = `${TRAKT_BASE_URL}/search/tmdb/${tmdbId}?type=${type}`;

    try {
        const response = await makeGetRequest(url, accessToken);
        if (response.length > 0 && response[0].type === type && response[0][type]) {
            const traktId = response[0][type].ids.trakt;
            return traktId;
        } else {
            throw new Error(`No Trakt ID found for TMDB ID ${tmdbId}`);
        }
    } catch (error) {
        log.error(`Error fetching Trakt ID for TMDB ID ${tmdbId}: ${error.message}`);
        throw error;
    }
}


const markContentAsWatched = async (access_token, type, id, watched_at) => {
    const url = `${TRAKT_BASE_URL}/sync/history`;
  
    let data = {};
    if (type === 'movies') {
      data = {
        movies: [{ ids: { trakt: id }, watched_at }]
      };
    } else if (type === 'series') {
      data = {
        shows: [{ ids: { trakt: id }, watched_at }]
      };
    }
  
    try {
      const response = await makePostRequest(url, data, access_token);
      return response;
    } catch (error) {
      log.error(`Error marking content as watched: ${error.message}`);
      throw error;
    }
  };

  const fetchTrendingLists = async (page = 1, limit = 10, accessToken = null) => {
    const endpoint = `/lists/trending?page=${page}&limit=${limit}`;
    const response = await fetchData(endpoint, {}, accessToken);
    return response;
};


const fetchPopularLists = async (page = 1, limit = 10, accessToken = null) => {
    const endpoint = `/lists/popular?page=${page}&limit=${limit}`;
    return await fetchData(endpoint, {}, accessToken);
};

const searchLists = async (query, page = 1, limit = 10, accessToken = null) => {
    const endpoint = `/search/list?query=${encodeURIComponent(query)}&page=${page}&limit=${limit}`;
    return await fetchData(endpoint, {}, accessToken);
};

const fetchListById = async (listId, accessToken = null) => {
    const endpoint = `/lists/${listId}`;
    return await fetchData(endpoint, {}, accessToken);
};

const fetchListItems = async (listId, type, page = 1, limit = 20, sortBy = null, sortHow = 'asc', accessToken = null) => {
    const endpoint = `/lists/${listId}/items/movies,shows`;

    let params = {};
    if (!sortBy) {
        params = { page, limit };
    }

    log.debug(`Fetching list items from Trakt API with listId: ${listId}, type: ${type}, page: ${page}, limit: ${limit}, sortBy: ${sortBy}, sortHow: ${sortHow}`);

    try {
        const data = await fetchData(endpoint, params, accessToken);

        log.debug(`Data successfully retrieved from Trakt API: ${endpoint}`);

        if (sortBy) {
            data.sort((a, b) => {
                let valueA, valueB;

                switch (sortBy) {
                    case 'rank':
                        valueA = a.rank;
                        valueB = b.rank;
                        break;
                    case 'listed_at':
                        valueA = new Date(a.listed_at);
                        valueB = new Date(b.listed_at);
                        break;
                    case 'title':
                        valueA = (a.movie?.title || a.show?.title || '').toLowerCase();
                        valueB = (b.movie?.title || b.show?.title || '').toLowerCase();
                        break;
                    case 'year':
                        valueA = a.movie?.year || a.show?.year || 0;
                        valueB = b.movie?.year || b.show?.year || 0;
                        break;
                    default:
                        return 0;
                }

                if (sortHow === 'desc') {
                    return valueA < valueB ? 1 : valueA > valueB ? -1 : 0;
                } else {
                    return valueA > valueB ? 1 : valueA < valueB ? -1 : 0;
                }
            });
        }

        return data;
    } catch (error) {
        log.error(`Error fetching list items from Trakt API: ${endpoint} - ${error.message}`);
        throw error;
    }
};

const fetchTrendingItems = async (type, page = 1, limit = 20, genre = null) => {
    const convertedType = type === 'movie' ? 'movies' : type === 'series' ? 'shows' : type;
    const endpoint = `/${convertedType}/trending`;
    const params = { page, limit };
    if (genre) {
        params.genres = genre;
    }

    try {
        log.debug(`Fetching trending items for type: ${type} (converted to ${convertedType}), page: ${page}, limit: ${limit}, genre: ${genre}`);
        const data = await fetchData(endpoint, params);
        log.debug(`Data successfully retrieved for trending ${convertedType}: ${endpoint}`);
        return data;
    } catch (error) {
        log.error(`Error fetching trending ${convertedType}: ${error.message}`);
        throw error;
    }
};

const fetchPopularItems = async (type, page = 1, limit = 20, genre = null) => {
    const convertedType = type === 'movie' ? 'movies' : type === 'series' ? 'shows' : type;
    const endpoint = `/${convertedType}/popular`;
    const params = { page, limit };
    if (genre) {
        params.genres = genre;
    }

    try {
        log.debug(`Fetching popular items for type: ${type} (converted to ${convertedType}), page: ${page}, limit: ${limit}, genre: ${genre}`);
        const data = await fetchData(endpoint, params);
        log.debug(`Data successfully retrieved for popular ${convertedType}: ${endpoint}`);
        return data;
    } catch (error) {
        log.error(`Error fetching popular ${convertedType}: ${error.message}`);
        throw error;
    }
};

const getAccessTokenForUser = async (username) => {
    try {
        const query = 'SELECT access_token FROM trakt_tokens WHERE username = $1';
        const result = await pool.query(query, [username]);

        if (result.rows.length === 0) {
            throw new Error(`No access token found for user ${username}`);
        }

        return result.rows[0].access_token;
    } catch (error) {
        log.error(`Error fetching access token for user ${username}: ${error.message}`);
        throw error;
    }
};

const fetchWatchlistItems = async (username, type = 'movie', page = 1, limit = 20) => {
    try {
        const accessToken = await getAccessTokenForUser(username);

        const convertedType = type === 'movie' ? 'movies' : type === 'series' ? 'shows' : type;
        const endpoint = `/users/${username}/watchlist/${convertedType}`;
        const params = { page, limit };

        log.debug(`Fetching watchlist items for user: ${username}, type: ${type} (converted to ${convertedType}), page: ${page}, limit: ${limit}`);

        const data = await fetchData(endpoint, params, accessToken);

        log.debug(`Data successfully retrieved for watchlist: ${endpoint}`);
        return data;
    } catch (error) {
        log.error(`Error fetching watchlist for user ${username}: ${error.message}`);
        throw error;
    }
};

const fetchRecommendations = async (username, type = 'movies', ignoreCollected = true, ignoreWatchlisted = true) => {
    try {
        const accessToken = await getAccessTokenForUser(username);

        const convertedType = type === 'movie' ? 'movies' : type === 'series' ? 'shows' : type;
        const endpoint = `/recommendations/${convertedType}`;
        const params = {
            ignore_collected: ignoreCollected,
            ignore_watchlisted: ignoreWatchlisted,
            limit: 100
        };

        log.debug(`Fetching recommendations for user: ${username}, type: ${type} (converted to ${convertedType}), limit: 100`);

        const data = await fetchData(endpoint, params, accessToken);

        log.debug(`Data successfully retrieved for recommendations: ${endpoint}`);
        return data;
    } catch (error) {
        log.error(`Error fetching recommendations for user ${username}: ${error.message}`);
        throw error;
    }
};

const fetchGenres = async (type) => {
    const endpoint = `/genres/${type}`;
  
    try {
      const genresData = await fetchData(endpoint);
      log.debug(`Genres retrieved for ${type}`);
      return genresData;
    } catch (error) {
      log.error(`Error fetching genres from Trakt: ${error.message}`);
      throw error;
    }
  };

const storeGenresInDb = async (genres, mediaType) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
  
        const insertGenreText = `
            INSERT INTO genres (genre_slug, genre_name, media_type)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
        `;
      
        for (const genre of genres) {
            await client.query(insertGenreText, [genre.slug, genre.name, mediaType]);
        }
  
        await client.query('COMMIT');
        log.info(`Genres stored for ${mediaType}`);
    } catch (err) {
        await client.query('ROLLBACK');
        log.error(`Error inserting genre: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
};

const fetchAndStoreGenres = async () => {
    try {
        const movieGenres = await fetchGenres('movies');
        const showGenres = await fetchGenres('shows');
  
        await storeGenresInDb(movieGenres, 'movie');
        await storeGenresInDb(showGenres, 'series');

        log.info(`Genres fetched and stored`);
    } catch (error) {
        log.error(`Error fetching/storing genres: ${error.message}`);
    }
};

module.exports = { makeGetRequest, makePostRequest, fetchUserHistory, fetchUserProfile, exchangeCodeForToken, handleTraktHistory, markContentAsWatched, lookupTraktId, saveUserWatchedHistory, fetchTrendingLists, fetchPopularLists, searchLists, fetchListById, fetchListItems, fetchTrendingItems, fetchPopularItems, fetchWatchlistItems, fetchRecommendations, fetchAndStoreGenres };
