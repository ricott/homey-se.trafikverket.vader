'use strict';

const assert = require('node:assert/strict');
const Trafikverket = require('../lib/tv_api.js');

// These are integration tests: they hit the live Trafikverket API and need an
// authentication key. Provide it either via TRAFIKVERKET_TOKEN or a local
// test/config.js exporting { token }. Both are untracked on purpose.
function resolveToken() {
    if (process.env.TRAFIKVERKET_TOKEN) {
        return process.env.TRAFIKVERKET_TOKEN;
    }

    try {
        return require('./config').token;
    } catch {
        return null;
    }
}

const token = resolveToken();

// Coordinates near Malmö, used for the radius searches.
const MALMO = { lat: 55.695530700000006, long: 13.0590207 };
const RADIUS = '20000m';

describe('VVIS', function () {
    // The live API is occasionally slow; the client itself times out at 10s.
    this.timeout(15000);

    let api;

    before(function () {
        if (!token) {
            this.skip();
        }
        api = new Trafikverket({ token });
    });

    describe('#getWeatherStationsByName()', function () {
        it('returns stations whose name starts with the search term', async function () {
            const result = await api.getWeatherStationsByName('Sto');
            const stations = result.RESPONSE.RESULT[0].WeatherMeasurepoint;

            assert.ok(Array.isArray(stations), 'expected an array of stations');
            assert.ok(stations.length > 0, 'expected at least one station');

            for (const station of stations) {
                assert.ok(station.Id, 'station is missing Id');
                assert.match(station.Name, /^Sto/i);
            }
        });

        it('escapes apostrophes instead of producing a malformed query', async function () {
            // Would previously break out of the XML attribute and fail the request.
            const result = await api.getWeatherStationsByName("Sto'");
            assert.ok(result.RESPONSE.RESULT[0], 'expected a well-formed response');
        });
    });

    describe('#getWeatherStationsByLocation()', function () {
        it('returns stations within the given radius', async function () {
            const result = await api.getWeatherStationsByLocation(MALMO.lat, MALMO.long, RADIUS);
            const stations = result.RESPONSE.RESULT[0].WeatherMeasurepoint;

            assert.ok(Array.isArray(stations), 'expected an array of stations');
            assert.ok(stations.length > 0, 'expected at least one nearby station');
        });
    });

    describe('#getWeatherStationDetails()', function () {
        // Station ids are not forever: the previous fixture (1227 'Lernacken')
        // was retired and silently broke this test.
        it('returns the named station with an observation', async function () {
            const result = await api.getWeatherStationDetails('1211');
            const measurepoint = result.RESPONSE.RESULT[0].WeatherMeasurepoint[0];

            assert.equal(measurepoint.Name, 'Löddeköpinge');
            assert.ok(measurepoint.Observation, 'expected an Observation object');
        });

        it('returns an empty result for an unknown station', async function () {
            const result = await api.getWeatherStationDetails('this-id-does-not-exist');
            assert.deepEqual(result.RESPONSE.RESULT[0].WeatherMeasurepoint, []);
        });
    });

    describe('#getImageURLForWeatherStation()', function () {
        it('returns cameras with a photo url', async function () {
            const result = await api.getImageURLForWeatherStation('Kävlinge');
            const cameras = result.RESPONSE.RESULT[0].Camera;

            assert.ok(Array.isArray(cameras), 'expected an array of cameras');
            assert.ok(cameras.length > 0, 'expected at least one camera');
            assert.ok(cameras[0].PhotoUrl, 'expected a PhotoUrl');
        });
    });

    describe('#getRoadConditionsByName()', function () {
        it('returns road conditions for a road number', async function () {
            const result = await api.getRoadConditionsByName('21');
            assert.ok(Array.isArray(result.RESPONSE.RESULT[0].RoadCondition));
        });
    });

    describe('#getRoadConditionsByLocation()', function () {
        it('returns road conditions within the given radius', async function () {
            const result = await api.getRoadConditionsByLocation(MALMO.lat, MALMO.long, RADIUS);
            assert.ok(Array.isArray(result.RESPONSE.RESULT[0].RoadCondition));
        });
    });

    describe('error handling', function () {
        it('emits api_error and rejects on an invalid token', async function () {
            const badApi = new Trafikverket({ token: 'not-a-valid-token' });

            const emitted = new Promise((resolve) => {
                badApi.once(Trafikverket.API_ERROR_EVENT, resolve);
            });

            await assert.rejects(() => badApi.getWeatherStationDetails('1227'));
            assert.ok((await emitted) instanceof Error, 'expected an Error to be emitted');
        });
    });
});
