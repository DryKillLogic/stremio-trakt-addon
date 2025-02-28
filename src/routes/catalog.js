const express = require('express');
const { pool } = require('../helpers/db');
const log = require('../helpers/logger');
const { fetchListItems, fetchWatchlistItems, fetchRecommendations, fetchTrendingItems, fetchPopularItems, handleTraktHistory } = require('../api/trakt');
const { getMetadataByTmdbId, getTvdbIdFromTmdb } = require('../api/tmdb');
const { getFanartLogo } = require('../api/fanart');
const { getRpdbPosterUrl } = require('../api/rpdb');

const getGenreSlug = async (genreName, mediaType) => {
    try {
        const result = await pool.query(
            "SELECT genre_slug FROM genres WHERE genre_name = $1 AND media_type = $2",
            [genreName, mediaType]
        );
        return result.rows.length ? result.rows[0].genre_slug : null;
    } catch (err) {
        throw err;
    }
};

const router = express.Router();

router.get("/:configParameters?/catalog/:type/:id/:extra?.json", async (req, res, next) => {
    const { type, id, extra } = req.params;
    let cleanId = id.startsWith('trakt_') ? id.replace('trakt_', '') : id;

    log.debug(`Type before processing: ${type}`);
    log.debug(`ID before processing: ${cleanId}`);

    const { configParameters } = req.params;
    let config = {};

    try {
        if (configParameters) {
            const decodedConfig = decodeURIComponent(configParameters);
            config = JSON.parse(decodedConfig);
        }

        const tmdbApiKey = config.tmdbApiKey;
        const fanartApiKey = config.fanartApiKey;
        const rpdbApiKey = config.rpdbApiKey;
        const language = config.language || 'en-US';
        const traktUsername = config.traktUsername;

        if (!tmdbApiKey) {
            return res.status(400).json({ error: 'TMDB API key is required' });
        }

        if (cleanId === 'watchlist_movies' || cleanId === 'watchlist_series') {
            if (!traktUsername) {
                return res.status(400).json({ error: 'Trakt username is required for fetching watchlist' });
            }
        }

        let skip = 0;
        let genre = null;
        let sortBy = null;
        let sortHow = 'asc';

        if (extra) {
            const extraParams = extra.split('&');
            for (const param of extraParams) {
                const [key, value] = param.split('=');
                if (key === 'skip' && !isNaN(value)) {
                    skip = parseInt(value);
                } else if (key === 'genre') {
                    genre = value;
                } else if (key === 'sortBy') {
                    const lastUnderscore = value.lastIndexOf('_');
                    if (lastUnderscore !== -1) {
                        sortBy = value.slice(0, lastUnderscore);
                        sortHow = value.slice(lastUnderscore + 1);
                    }
                }
            }
        }

        const limit = 20;
        const page = Math.floor(skip / limit) + 1;

        let genreSlug = null;
        if (genre) {
            genreSlug = await getGenreSlug(genre, type);
            if (!genreSlug) {
                return res.status(400).json({ error: `Genre '${genre}' not found for type '${type}'` });
            }
        }

        log.debug(`Fetching list items with skip: ${skip}, limit: ${limit}, page: ${page}, genre: ${genre}, genreSlug: ${genreSlug}, sortBy: ${sortBy}, sortHow: ${sortHow}`);

        let allItems = [];
        
        switch (cleanId) {
            case 'watchlist_movies':
            case 'watchlist_series':
                log.debug(`Fetching watchlist for ${type} and user: ${traktUsername}`);
                allItems = await fetchWatchlistItems(traktUsername, type, page, limit);
                break;
            case 'recommendations_movies':
            case 'recommendations_series':
                log.debug(`Fetching recommendations for ${type} and user: ${traktUsername}`);
                allItems = await fetchRecommendations(traktUsername, type, true, true);
                break;
            case 'trending_movies':
            case 'trending_series':
                log.debug(`Fetching trending items for ${type}`);
                allItems = await fetchTrendingItems(type, page, limit, genreSlug);
                break;
            case 'popular_movies':
            case 'popular_series':
                log.debug(`Fetching popular items for ${type}`);
                allItems = await fetchPopularItems(type, page, limit, genreSlug);
                break;
            default:
                log.debug(`Fetching list items from Trakt API for list ${cleanId}`);
                if (sortBy) {
                    log.debug(`Sorting provided: ignoring pagination, using sortBy: ${sortBy} and sortHow: ${sortHow}`);
                    allItems = await fetchListItems(cleanId, type, null, null, sortBy, sortHow);
                } else {
                    log.debug(`No sorting provided: using pagination with page: ${page}, limit: ${limit}`);
                    allItems = await fetchListItems(cleanId, type, page, limit);
                }
                break;
        }

        log.debug(`Items fetched for list ${cleanId}: ${allItems.length} items`);

        const paginatedItems = sortBy ? allItems.slice(skip, skip + limit) : allItems;

        const metas = await Promise.all(paginatedItems.map(async (item) => {
            let logoUrl = '';
            let posterUrl = '';

            if (type === 'movie' || type === 'movies') {
                const movie = item.movie || item;
                if (movie && movie.ids && movie.ids.tmdb) {
                    try {
                        const tmdbDetails = await getMetadataByTmdbId(movie.ids.tmdb, 'movie', tmdbApiKey, language);
                        if (rpdbApiKey) {
                            const rpdbPosterUrl = await getRpdbPosterUrl('movie', movie.ids.tmdb, language, rpdbApiKey);
                            posterUrl = rpdbPosterUrl || tmdbDetails.poster;
                        } else {
                            posterUrl = tmdbDetails.poster;
                        }

                        if (fanartApiKey) {
                            logoUrl = await getFanartLogo(movie.ids.tmdb, language, fanartApiKey, 'movie');
                        }

                        return {
                            id: `${movie.ids.imdb}`,
                            type: 'movie',
                            name: tmdbDetails.title,
                            poster: posterUrl,
                            logo: logoUrl,
                            description: tmdbDetails.description,
                            releaseInfo: tmdbDetails.releaseDate,
                            posterShape: 'poster',
                            imdbRating: tmdbDetails.imdbRating,
                            genres: tmdbDetails.genres,
                            runtime: tmdbDetails.runtime
                        };
                    } catch (error) {
                        log.error(`Error fetching TMDB details for movie: ${movie.title}, TMDB ID: ${movie.ids.tmdb} - ${error.message}`);
                        return null;
                    }
                }
            }
            else if (type === 'series' || type === 'tv') {
                const show = item.show || item;
                if (show && show.ids && show.ids.tmdb) {
                    try {
                        const tmdbDetails = await getMetadataByTmdbId(show.ids.tmdb, 'tv', tmdbApiKey, language);
                        if (rpdbApiKey) {
                            const rpdbPosterUrl = await getRpdbPosterUrl('series', show.ids.tmdb, language, rpdbApiKey);
                            posterUrl = rpdbPosterUrl || tmdbDetails.poster;
                        } else {
                            posterUrl = tmdbDetails.poster;
                        }
            
                        if (fanartApiKey) {
                            try {
                                if (tmdbDetails.tvdbId) {
                                    logoUrl = await getFanartLogo(tmdbDetails.tvdbId, language, fanartApiKey, 'tv');
                                } else {
                                    log.warn(`No TVDB ID found for show with TMDB ID: ${show.ids.tmdb}`);
                                }
                            } catch (error) {
                                log.error(`Error getting Fanart logo for show: ${error.message}`);
                            }
                        }
            
                        const releaseInfo = tmdbDetails.releaseDate === tmdbDetails.lastAirDate
                            ? tmdbDetails.releaseDate
                            : `${tmdbDetails.releaseDate}-${tmdbDetails.lastAirDate}`;
            
                        return {
                            id: `${show.ids.imdb}`,
                            type: 'series',
                            name: tmdbDetails.title,
                            poster: posterUrl,
                            logo: logoUrl,
                            description: tmdbDetails.description,
                            releaseInfo,
                            posterShape: 'poster',
                            imdbRating: tmdbDetails.imdbRating,
                            genres: tmdbDetails.genres,
                            runtime: tmdbDetails.runtime
                        };
                    } catch (error) {
                        log.error(`Error fetching TMDB details for show: ${show.title}, TMDB ID: ${show.ids.tmdb} - ${error.message}`);
                        return null;
                    }
                }
            }
            else if (type === 'list') {
                const listItem = item;

                if (listItem && listItem.movie && listItem.movie.ids && listItem.movie.ids.tmdb) {
                    try {
                        const tmdbDetails = await getMetadataByTmdbId(listItem.movie.ids.tmdb, 'movie', tmdbApiKey, language);
                        if (rpdbApiKey) {
                            const rpdbPosterUrl = await getRpdbPosterUrl('movie', listItem.movie.ids.tmdb, language, rpdbApiKey);
                            posterUrl = rpdbPosterUrl || tmdbDetails.poster;
                        } else {
                            posterUrl = tmdbDetails.poster;
                        }

                        if (fanartApiKey) {
                            logoUrl = await getFanartLogo(listItem.movie.ids.tmdb, language, fanartApiKey, 'movie');
                        }

                        return {
                            id: `${listItem.movie.ids.imdb}`,
                            type: 'movie',
                            name: listItem.movie.title,
                            poster: posterUrl,
                            logo: logoUrl,
                            description: tmdbDetails.description,
                            releaseInfo: tmdbDetails.releaseDate,
                            posterShape: 'poster',
                            imdbRating: tmdbDetails.imdbRating,
                            genres: tmdbDetails.genres,
                            runtime: tmdbDetails.runtime
                        };
                    } catch (error) {
                        log.error(`Error fetching TMDB details for list item: ${listItem.movie.title}, TMDB ID: ${listItem.movie.ids.tmdb} - ${error.message}`);
                        return null;
                    }
                }
                else if (listItem && listItem.show && listItem.show.ids && listItem.show.ids.tmdb) {
                    try {
                        const tmdbDetails = await getMetadataByTmdbId(listItem.show.ids.tmdb, 'tv', tmdbApiKey, language);
                        if (rpdbApiKey) {
                            const rpdbPosterUrl = await getRpdbPosterUrl('series', listItem.show.ids.tmdb, language, rpdbApiKey);
                            posterUrl = rpdbPosterUrl || tmdbDetails.poster;
                        } else {
                            posterUrl = tmdbDetails.poster;
                        }

                        if (fanartApiKey) {
                            try {
                                if (tmdbDetails.tvdbId) {
                                    logoUrl = await getFanartLogo(tmdbDetails.tvdbId, language, fanartApiKey, 'tv');
                                } else {
                                    log.warn(`No TVDB ID found for show with TMDB ID: ${listItem.show.ids.tmdb}`);
                                }
                            } catch (error) {
                                log.error(`Error getting Fanart logo for show: ${error.message}`);
                            }
                        }

                        const releaseInfo = tmdbDetails.releaseDate === tmdbDetails.lastAirDate
                            ? tmdbDetails.releaseDate
                            : `${tmdbDetails.releaseDate}-${tmdbDetails.lastAirDate}`;
            
                        return {
                            id: `${listItem.show.ids.imdb}`,
                            type: 'series',
                            name: listItem.show.title,
                            poster: posterUrl,
                            logo: logoUrl,
                            description: tmdbDetails.description,
                            releaseInfo,
                            posterShape: 'poster',
                            imdbRating: tmdbDetails.imdbRating,
                            genres: tmdbDetails.genres,
                            runtime: tmdbDetails.runtime
                        };
                    } catch (error) {
                        log.error(`Error fetching TMDB details for list item: ${listItem.show.title}, TMDB ID: ${listItem.show.ids.tmdb} - ${error.message}`);
                        return null;
                    }
                }
            }
            else {
                log.warn(`Unknown type in route: ${type}`);
                return null;
            }
        }).filter(Boolean));
        try {
            let updatedMetas = metas;

            if (config.markContentHistory) {
                updatedMetas = await handleTraktHistory(config, metas, type);
            }

            res.json({ metas: updatedMetas });
        } catch (error) {
            log.error(`Error handling Trakt history: ${error.message}`);
            res.status(500).json({ error: "Error handling Trakt history." });
        }
    } catch (error) {
        log.error('Error in /catalog route:', error);
        return res.status(500).json({ error: "Invalid configParameters or server error." });
    }
});

module.exports = router;
