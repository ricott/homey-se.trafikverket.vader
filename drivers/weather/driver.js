'use strict';

const Homey = require('homey');
const Trafikverket = require('../../lib/tv_api.js');

/** Radius used when listing stations near Homey's own location. */
const NEARBY_SEARCH_RADIUS = '20000m';

class WeatherDriver extends Homey.Driver {

    async onInit() {
        this.log('Trafikverket weather driver has been initialized');

        this.#registerFlows();
    }

    #registerFlows() {
        this.log('Registering flows');

        this.snowChangedTrigger = this.homey.flow.getDeviceTriggerCard('snowChanged');

        this.homey.flow.getConditionCard('rainAmount')
            .registerRunListener(async (args) => {
                const rain = args.device.getCapabilityValue('measure_rain');
                this.log(`[${args.device.getName()}] Condition 'rainAmount': ${rain} > ${args.rain}?`);
                return rain > args.rain;
            });

        this.homey.flow.getConditionCard('snowAmount')
            .registerRunListener(async (args) => {
                const snow = args.device.getCapabilityValue('measure_rain.snow');
                this.log(`[${args.device.getName()}] Condition 'snowAmount': ${snow} > ${args.snow}?`);
                return snow > args.snow;
            });
    }

    /**
     * @param {import('homey').Device} device
     * @param {object} tokens
     */
    async triggerSnowChanged(device, tokens) {
        try {
            await this.snowChangedTrigger.trigger(device, {}, tokens);
        } catch (error) {
            this.error("Failed to trigger 'snowChanged':", error);
        }
    }

    /**
     * @param {import('homey').Driver.PairSession} session
     */
    async onPair(session) {
        // Scoped to this pair session rather than the driver, so concurrent
        // pairing sessions can't overwrite each other's search term.
        let stationName = null;

        session.setHandler('settings', async (data) => {
            stationName = data?.stationName?.trim() || null;

            if (stationName) {
                this.log(`User wants to search for '${stationName}'`);
            } else {
                this.log('User decided to search for stations nearby Homey location');
            }

            await session.showView('list_devices');
            return 'done';
        });

        session.setHandler('list_devices', async () => {
            // See the note in device.js: env.json is only exposed as `Homey.env`.
            const api = new Trafikverket({ token: Homey.env.API_KEY });

            try {
                const response = stationName
                    ? await api.getWeatherStationsByName(stationName)
                    : await api.getWeatherStationsByLocation(
                        this.homey.geolocation.getLatitude(),
                        this.homey.geolocation.getLongitude(),
                        NEARBY_SEARCH_RADIUS,
                    );

                const stations = response?.RESPONSE?.RESULT?.[0]?.WeatherMeasurepoint;

                if (!Array.isArray(stations) || stations.length === 0) {
                    this.log('No weather stations received in API response');
                    return [];
                }

                return stations.map((station) => ({
                    name: station.Name,
                    data: { id: station.Id },
                }));
            } catch (error) {
                this.error('Failed to get weather stations:', error);
                // Surfaces as an error in the pairing wizard instead of an
                // empty list that looks like "no stations found".
                throw new Error(this.homey.__('pair.error'), { cause: error });
            } finally {
                api.removeAllListeners();
            }
        });
    }

}

module.exports = WeatherDriver;
