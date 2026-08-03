'use strict';

const EventEmitter = require('node:events');

const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const API_TIMEOUT_MS = 10_000;

const API_ERROR_EVENT = 'api_error';

const SCHEMA_ROAD_CONDITION = '1.2';
const SCHEMA_WEATHER_MEASUREPOINT = '2.1';
const SCHEMA_CAMERA = '1';

/**
 * Escapes a value for safe use inside a single-quoted XML attribute.
 *
 * Trafikverket's API is queried with an XML document that embeds user input
 * (station names, road numbers). Without escaping, a name containing an
 * apostrophe -- common in Swedish place names -- produces a malformed request,
 * and a crafted name could rewrite the query itself.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeXmlAttribute(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

/**
 * Client for the Trafikverket "Trafikinfo" open data API.
 *
 * Emits `api_error` with the underlying Error whenever a query fails, in
 * addition to rejecting the returned promise.
 */
class Trafikverket extends EventEmitter {

    /**
     * @param {object} [options]
     * @param {string} [options.token] Trafikverket API authentication key.
     */
    constructor(options = {}) {
        super();
        this.options = options;
    }

    /**
     * Posts a raw XML query and returns the parsed JSON response.
     *
     * @param {string} xmlQuery
     * @returns {Promise<object>}
     */
    async postCommand(xmlQuery) {
        let response;

        try {
            response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml',
                    Accept: 'application/json',
                },
                body: xmlQuery,
                signal: AbortSignal.timeout(API_TIMEOUT_MS),
            });
        } catch (cause) {
            // AbortSignal.timeout() rejects with a TimeoutError DOMException.
            if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
                throw new Error(`Trafikverket request timed out after ${API_TIMEOUT_MS}ms`, { cause });
            }
            throw new Error(`Trafikverket request failed: ${cause.message}`, { cause });
        }

        if (!response.ok) {
            const body = await response.text().catch(() => '<unreadable body>');
            throw new Error(`Trafikverket request failed with HTTP ${response.status} ${response.statusText}: ${body}`);
        }

        return response.json();
    }

    /**
     * Wraps a query in the standard REQUEST/LOGIN envelope, executes it, and
     * re-emits any failure as an `api_error` event before re-throwing.
     *
     * @param {string} query
     * @returns {Promise<object>}
     */
    async #query(query) {
        // Without this the API answers with a generic HTTP 401 'Invalid
        // authentication', which gives no hint that the key was never supplied.
        if (!this.options.token) {
            const error = new Error('No Trafikverket API key configured (expected API_KEY in env.json, read via Homey.env)');
            this.emit(API_ERROR_EVENT, error);
            throw error;
        }

        const xml = `<REQUEST><LOGIN authenticationkey='${escapeXmlAttribute(this.options.token)}'/>${query}</REQUEST>`;

        try {
            return await this.postCommand(xml);
        } catch (error) {
            this.emit(API_ERROR_EVENT, error);
            throw error;
        }
    }

    /**
     * @param {string|number} roadNumber
     */
    async getRoadConditionsByName(roadNumber) {
        return this.#query(
            `<QUERY objecttype='RoadCondition' schemaversion='${SCHEMA_ROAD_CONDITION}'>`
            + '<FILTER>'
            + `<EQ name='RoadNumberNumeric' value='${escapeXmlAttribute(roadNumber)}' />`
            + '</FILTER>'
            + '<INCLUDE>Id</INCLUDE>'
            + '<INCLUDE>LocationText</INCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * @param {number|string} lat
     * @param {number|string} long
     * @param {string} radius e.g. '20000m'
     */
    async getRoadConditionsByLocation(lat, long, radius) {
        return this.#query(
            `<QUERY objecttype='RoadCondition' schemaversion='${SCHEMA_ROAD_CONDITION}'>`
            + '<FILTER>'
            + `<WITHIN name='Geometry.WGS84' shape='center' value='${escapeXmlAttribute(long)} ${escapeXmlAttribute(lat)}' radius='${escapeXmlAttribute(radius)}' />`
            + '</FILTER>'
            + '<INCLUDE>Id</INCLUDE>'
            + '<INCLUDE>LocationText</INCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * @param {string} conditionId
     */
    async getRoadConditionDetails(conditionId) {
        return this.#query(
            `<QUERY objecttype='RoadCondition' schemaversion='${SCHEMA_ROAD_CONDITION}'>`
            + '<FILTER>'
            + `<EQ name='Id' value='${escapeXmlAttribute(conditionId)}' />`
            + '</FILTER>'
            + '<INCLUDE>Id</INCLUDE>'
            + '<INCLUDE>CountyNo</INCLUDE>'
            + '<INCLUDE>ConditionCode</INCLUDE>'
            + '<INCLUDE>ConditionInfo</INCLUDE>'
            + '<INCLUDE>ConditionText</INCLUDE>'
            + '<INCLUDE>LocationText</INCLUDE>'
            + '<INCLUDE>RoadNumber</INCLUDE>'
            + '<INCLUDE>StartTime</INCLUDE>'
            + '<INCLUDE>ModifiedTime</INCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * Searches weather stations whose name starts with `name`.
     *
     * @param {string} name
     */
    async getWeatherStationsByName(name) {
        return this.#query(
            `<QUERY objecttype='WeatherMeasurepoint' schemaversion='${SCHEMA_WEATHER_MEASUREPOINT}'>`
            + '<FILTER>'
            + `<LIKE name='Name' value='^${escapeXmlAttribute(name)}' />`
            + '</FILTER>'
            + '<INCLUDE>Id</INCLUDE>'
            + '<INCLUDE>Name</INCLUDE>'
            + '<INCLUDE>Geometry.WGS84</INCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * @param {number|string} lat
     * @param {number|string} long
     * @param {string} radius e.g. '20000m'
     */
    async getWeatherStationsByLocation(lat, long, radius) {
        return this.#query(
            `<QUERY objecttype='WeatherMeasurepoint' schemaversion='${SCHEMA_WEATHER_MEASUREPOINT}'>`
            + '<FILTER>'
            + `<WITHIN name='Geometry.WGS84' shape='center' value='${escapeXmlAttribute(long)} ${escapeXmlAttribute(lat)}' radius='${escapeXmlAttribute(radius)}' />`
            + '</FILTER>'
            + '<INCLUDE>Id</INCLUDE>'
            + '<INCLUDE>Name</INCLUDE>'
            + '<INCLUDE>Geometry.WGS84</INCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * @param {string} stationId
     */
    async getWeatherStationDetails(stationId) {
        return this.#query(
            `<QUERY objecttype='WeatherMeasurepoint' schemaversion='${SCHEMA_WEATHER_MEASUREPOINT}'>`
            + '<FILTER>'
            + `<EQ name='Id' value='${escapeXmlAttribute(stationId)}' />`
            + '</FILTER>'
            + '<EXCLUDE>Observation.Aggregated10minutes</EXCLUDE>'
            + '<EXCLUDE>Observation.Aggregated5minutes</EXCLUDE>'
            + '</QUERY>',
        );
    }

    /**
     * Finds road cameras whose name starts with `stationName`.
     *
     * @param {string} stationName
     */
    async getImageURLForWeatherStation(stationName) {
        return this.#query(
            `<QUERY objecttype='Camera' schemaversion='${SCHEMA_CAMERA}'>`
            + '<FILTER>'
            + `<LIKE name='Name' value='^${escapeXmlAttribute(stationName)}' />`
            + '</FILTER>'
            + '<INCLUDE>PhotoUrl</INCLUDE>'
            + '<INCLUDE>HasFullSizePhoto</INCLUDE>'
            + '<INCLUDE>Type</INCLUDE>'
            + '<INCLUDE>Name</INCLUDE>'
            + '<INCLUDE>Id</INCLUDE>'
            + '</QUERY>',
        );
    }

}

module.exports = Trafikverket;
module.exports.API_ERROR_EVENT = API_ERROR_EVENT;
module.exports.escapeXmlAttribute = escapeXmlAttribute;
