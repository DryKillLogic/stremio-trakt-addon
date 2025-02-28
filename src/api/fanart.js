const axios = require('axios');
const log = require('../helpers/logger');

const getFanartLogo = async (id, preferredLang, fanartApiKey, type) => {
    try {
        const mediaType = type === 'tv' || type === 'series' ? 'tv' : 'movies';
        const idType = mediaType === 'tv' ? 'thetvdb' : 'tmdb';
        
        if (!id) {
            log.warn(`No ${idType} ID provided for type ${type}`);
            return '';
        }

        const url = `https://webservice.fanart.tv/v3/${mediaType}/${id}/?api_key=${fanartApiKey}`;
        
        log.debug(`Fetching Fanart logos from: ${url} using ${idType} ID`);

        const response = await axios.get(url);
        
        const logos = mediaType === 'tv' ? response.data.hdtvlogo : response.data.hdmovielogo || [];
        
        log.debug(`Logos fetched: ${JSON.stringify(logos)}`);

        const preferredLangLogos = logos.filter(logo => logo.lang === preferredLang);
        log.debug(`Logos in preferred language (${preferredLang}): ${JSON.stringify(preferredLangLogos)}`);

        const bestLogoInPreferredLang = preferredLangLogos.sort((a, b) => b.likes - a.likes)[0];
        log.debug(`Best logo in preferred language: ${JSON.stringify(bestLogoInPreferredLang)}`);

        if (!bestLogoInPreferredLang) {
            const englishLogos = logos.filter(logo => logo.lang === 'en');
            log.debug(`Logos in English: ${JSON.stringify(englishLogos)}`);

            const bestLogoInEnglish = englishLogos.sort((a, b) => b.likes - a.likes)[0];
            log.debug(`Best logo in English: ${JSON.stringify(bestLogoInEnglish)}`);

            return bestLogoInEnglish ? bestLogoInEnglish.url.replace('http://', 'https://') : '';
        }

        const bestLogoUrl = bestLogoInPreferredLang.url.replace('http://', 'https://');
        log.debug(`Best logo URL: ${bestLogoUrl}`);
        return bestLogoUrl;
    } catch (error) {
        const idType = type === 'tv' || type === 'series' ? 'thetvdb' : 'tmdb';
        log.error(`Error fetching logos from Fanart.tv for ${idType} ID ${id}:`, error.message);
        return '';
    }
};

module.exports = { getFanartLogo };
