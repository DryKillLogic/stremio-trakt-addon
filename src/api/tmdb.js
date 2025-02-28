const axios = require('axios');
const log = require('../helpers/logger');
const addToQueueTMDB = require('../helpers/bottleneck_tmdb');
const { safeRedisCall } = require('../helpers/redis');
const { parseCacheDuration } = require('../helpers/cache');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const generateRedisKey = (tmdbId, type, language) => {
    return `tmdb:${type}:${tmdbId}:${language}`;
};

const formatRuntime = (runtime) => {
    if (!runtime) return null;

    const hours = Math.floor(runtime / 60);
    const minutes = runtime % 60;

    if (hours > 0 && minutes > 0) {
        return `${hours}h${minutes.toString().padStart(2, '0')}`;
    } else if (hours > 0) {
        return `${hours}h`;
    } else {
        return `${minutes}m`;
    }
};

const getMetadataByTmdbId = async (tmdbId, type, tmdbApiKey, language = 'en-US') => {
    const redisKey = generateRedisKey(tmdbId, type, language);
    const endpoint = `${TMDB_BASE_URL}/${type}/${tmdbId}?api_key=${tmdbApiKey}&language=${language}${type === 'tv' ? '&append_to_response=external_ids' : ''}`;

    try {
        const cachedData = await safeRedisCall('get', redisKey);
        if (cachedData) {
            log.debug(`TMDB data for ${type} with ID ${tmdbId} in language ${language} found in cache.`);
            return JSON.parse(cachedData);
        }

        const response = await addToQueueTMDB({
            fn: () => axios.get(endpoint)
        });

        const data = response.data;
        
        log.debug(`TMDB response for ${type} with ID ${tmdbId}: ${JSON.stringify(data.external_ids)}`);

        const result = {
            title: data.title || data.name,
            poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
            description: data.overview,
            releaseDate: (data.release_date || data.first_air_date || '').slice(0, 4),
            lastAirDate: data.last_air_date ? data.last_air_date.slice(0, 4) : null,
            imdbRating: data.vote_average ? data.vote_average.toFixed(1) : null,
            genres: data.genres ? data.genres.map(genre => genre.name) : [],
            runtime: formatRuntime(data.runtime),
            tvdbId: type === 'tv' && data.external_ids && data.external_ids.tvdb_id ? data.external_ids.tvdb_id : null
        };

        const cacheDuration = parseCacheDuration(process.env.TMDB_CACHE_DURATION || '1d');
        await safeRedisCall('set', redisKey, JSON.stringify(result), 'EX', cacheDuration);

        log.debug(`TMDB API request successful for ${type} with ID ${tmdbId} in language ${language}. Data cached.`);

        return result;
    } catch (error) {
        log.error(`Error fetching TMDB details for ${type} with ID ${tmdbId}: ${error.message}`);
        throw error;
    }
};

module.exports = { getMetadataByTmdbId };
