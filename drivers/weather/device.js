'use strict';

const Homey = require('homey');
const Trafikverket = require('../../lib/tv_api.js');

const DEVICE_CLASS = 'service';

/** Capabilities added to devices that were paired before these existed. */
const CAPABILITIES_TO_ADD = ['measure_rain.snow', 'measure_rain.total'];

/** Camera image init is retried on failure, with a bounded number of attempts. */
const CAMERA_INIT_MAX_ATTEMPTS = 3;
const CAMERA_INIT_RETRY_MS = 30_000;

const COMPASS_POINTS = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
];

/**
 * Converts a wind direction in degrees to a 16-point compass abbreviation.
 *
 * Sector boundaries round up, so 11.25 is NNE and 33.75 is NE. Degrees outside
 * 0..360 are normalised rather than collapsed to 'N'.
 *
 * @param {number|string} degrees
 * @returns {string} One of COMPASS_POINTS, defaulting to 'N' for bad input.
 */
function degreesToCompassPoint(degrees) {
    const value = Number.parseFloat(degrees);
    if (!Number.isFinite(value)) {
        return 'N';
    }

    // Each sector spans 22.5 degrees and is centred on its compass point, so
    // offset by half a sector before flooring.
    const sector = Math.floor(((value % 360) + 360) % 360 / 22.5 + 0.5);
    return COMPASS_POINTS[sector % COMPASS_POINTS.length];
}

class WeatherDevice extends Homey.Device {

    async onInit() {
        this.log(`Trafikverket weather station initiated, '${this.getName()}'`);

        // Older versions of this app paired devices with a different class.
        if (this.getClass() !== DEVICE_CLASS) {
            await this.setClass(DEVICE_CLASS);
        }

        /** @type {Map<string, import('homey').Image>} */
        this.weatherImages = new Map();
        this.refreshTimer = null;

        await this.setupCapabilities();

        // Note: env.json is exposed as the static `Homey.env`, which is how the
        // Homey CLI injects it. `this.homey.env` is not populated here -- using
        // it silently yields an empty token and a confusing HTTP 401.
        this.api = new Trafikverket({
            token: Homey.env.API_KEY,
            device: this,
        });
        this.#registerApiErrorListener();

        await this.refreshWeatherSiteStatus();
        await this.initializeCameraImages();

        this.#startRefreshTimer();
    }

    async setupCapabilities() {
        this.log('Setting up capabilities');

        for (const capability of CAPABILITIES_TO_ADD) {
            await this.addCapabilityHelper(capability);
        }
    }

    /**
     * @param {string} capability
     */
    async removeCapabilityHelper(capability) {
        if (!this.hasCapability(capability)) {
            return;
        }

        try {
            this.log(`Removing existing capability '${capability}'`);
            await this.removeCapability(capability);
        } catch (error) {
            this.error(`Failed to remove capability '${capability}'`, error);
        }
    }

    /**
     * @param {string} capability
     */
    async addCapabilityHelper(capability) {
        if (this.hasCapability(capability)) {
            return;
        }

        try {
            this.log(`Adding missing capability '${capability}'`);
            await this.addCapability(capability);
        } catch (error) {
            this.error(`Failed to add capability '${capability}'`, error);
        }
    }

    /**
     * Surfaces API failures in the device's debug settings so users can report
     * them without needing app logs.
     */
    #registerApiErrorListener() {
        this.api.on(Trafikverket.API_ERROR_EVENT, async (error) => {
            this.error('API error occurred:', error);

            const message = error instanceof Error
                ? (error.stack ?? error.message)
                : this.#stringify(error);

            await this.#updateSettings({
                last_error: `${new Date().toISOString()}\n${message}`,
            });
        });
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    #stringify(value) {
        try {
            return JSON.stringify(value, null, 2);
        } catch (error) {
            this.error('Failed to stringify value:', error);
            return String(value);
        }
    }

    /**
     * setSettings() rejects if the device is being deleted, which must never
     * take down the surrounding refresh or error-reporting flow.
     *
     * @param {object} settings
     */
    async #updateSettings(settings) {
        try {
            await this.setSettings(settings);
        } catch (error) {
            this.error('Failed to update device settings:', error);
        }
    }

    /**
     * Builds the image URL for a camera, preferring the full size variant.
     *
     * @param {object} camera
     * @returns {string|null} null when the camera has no usable URL.
     */
    createCameraImageURL(camera) {
        const photoUrl = String(camera?.PhotoUrl ?? '').trim();
        if (!photoUrl) {
            this.error('Camera has no usable PhotoUrl:', camera);
            return null;
        }

        // The API is inconsistent about whether this flag is a boolean or a string.
        const hasFullSize = camera.HasFullSizePhoto === true || camera.HasFullSizePhoto === 'true';
        return hasFullSize ? `${photoUrl}?type=fullsize` : photoUrl;
    }

    /**
     * Registers a Homey camera image for every road camera at this station.
     *
     * @param {number} [attempt] Current attempt, used to bound retries.
     */
    async initializeCameraImages(attempt = 1) {
        this.log(`Initializing camera images (attempt ${attempt}/${CAMERA_INIT_MAX_ATTEMPTS})`);

        let cameras;
        try {
            const message = await this.api.getImageURLForWeatherStation(this.getName());
            cameras = message?.RESPONSE?.RESULT?.[0]?.Camera;
        } catch (error) {
            this.error('Failed to fetch camera images:', error);
            this.#scheduleCameraImageRetry(attempt);
            return;
        }

        if (!Array.isArray(cameras) || cameras.length === 0) {
            this.log('No cameras found for this weather station');
            return;
        }

        this.log(`Found ${cameras.length} camera(s) for station '${this.getName()}'`);

        // Sequentially, so Homey isn't asked to register several images at once.
        for (const camera of cameras) {
            await this.initializeSingleCamera(camera);
        }

        this.log(`Successfully initialized ${this.weatherImages.size} camera image(s)`);
    }

    /**
     * @param {number} attempt
     */
    #scheduleCameraImageRetry(attempt) {
        if (attempt >= CAMERA_INIT_MAX_ATTEMPTS) {
            this.error(`Giving up on camera images after ${attempt} attempt(s)`);
            return;
        }

        // homey.setTimeout is used rather than the global so the timer is
        // cleaned up automatically when the app or device unloads.
        this.homey.setTimeout(() => {
            this.initializeCameraImages(attempt + 1).catch((error) => {
                this.error('Camera image retry failed:', error);
            });
        }, CAMERA_INIT_RETRY_MS);
    }

    /**
     * @param {object} camera
     */
    async initializeSingleCamera(camera) {
        if (!camera?.Id || !camera?.Name) {
            this.error('Skipping camera without Id or Name:', camera);
            return;
        }

        const imageUrl = this.createCameraImageURL(camera);
        if (!imageUrl) {
            return;
        }

        this.log(`Registering camera '${camera.Name}' (${camera.Id}) with URL ${imageUrl}`);

        let image;
        try {
            image = await this.homey.images.createImage();
            image.setUrl(imageUrl);
            await this.setCameraImage(camera.Id, camera.Name, image);

            this.weatherImages.set(camera.Id, image);
            this.log(`Successfully initialized camera '${camera.Name}'`);
        } catch (error) {
            this.error(`Failed to initialize camera '${camera.Name}':`, error);

            // Avoid leaking the orphaned image if registration failed.
            if (image) {
                await image.unregister().catch((unregisterError) => {
                    this.error(`Failed to unregister image for camera '${camera.Name}':`, unregisterError);
                });
            }
        }
    }

    async refreshWeatherSiteStatus() {
        try {
            const message = await this.api.getWeatherStationDetails(this.getData().id);
            const measurepoint = message?.RESPONSE?.RESULT?.[0]?.WeatherMeasurepoint?.[0];

            if (!measurepoint) {
                throw new Error('API response contained no WeatherMeasurepoint');
            }

            await this.#updateObservation(measurepoint.Observation ?? {});
            await this.#updateSettings({ last_response: this.#stringify(measurepoint) });
        } catch (error) {
            this.error('Failed to refresh weather site status:', error);
        }

        await this.#refreshCameraImages();
    }

    /**
     * Maps a WeatherMeasurepoint observation onto this device's capabilities.
     *
     * A station only reports the fields it has sensors for, and the API omits
     * `Value` entirely for the rest. Those are passed through as undefined so
     * _updateProperty() leaves the capability untouched -- reporting 0 instead
     * would show a station with no road sensor as a road surface of 0 degrees
     * and pollute Insights history.
     *
     * @param {object} observation
     */
    async #updateObservation(observation) {
        const wind = observation?.Wind?.[0];
        const windDirection = wind?.Direction?.Value;
        const precipitation = observation?.Aggregated30minutes?.Precipitation;

        await this._updateProperty('measure_temperature', observation?.Air?.Temperature?.Value);
        await this._updateProperty('measure_temperature.surface', observation?.Surface?.Temperature?.Value);
        await this._updateProperty('measure_humidity', observation?.Air?.RelativeHumidity?.Value);

        await this._updateProperty('measure_wind_strength', wind?.Speed?.Value);
        await this._updateProperty('measure_wind_angle', windDirection);
        await this._updateProperty(
            'wind_angle_text',
            windDirection === undefined ? undefined : this.homey.__(`wind.${degreesToCompassPoint(windDirection)}`),
        );

        await this._updateProperty('measure_gust_strength', observation?.Aggregated30minutes?.Wind?.SpeedMax?.Value);
        await this._updateProperty('measure_rain', precipitation?.RainSum?.Value);
        await this._updateProperty('measure_rain.snow', precipitation?.SnowSum?.Solid?.Value);
        await this._updateProperty('measure_rain.total', precipitation?.TotalWaterEquivalent?.Value);
    }

    /**
     * Re-fetches each camera image. The URLs are stable, so only the image
     * contents need refreshing.
     */
    async #refreshCameraImages() {
        if (this.weatherImages.size === 0) {
            return;
        }

        this.log(`Refreshing ${this.weatherImages.size} camera image(s)`);

        for (const [cameraId, image] of this.weatherImages) {
            try {
                await image.update();
            } catch (error) {
                this.error(`Failed to update camera image '${cameraId}', dropping it:`, error);
                this.weatherImages.delete(cameraId);
            }
        }
    }

    /**
     * @param {number} [intervalMinutes] Defaults to the stored setting.
     */
    #startRefreshTimer(intervalMinutes = this.getSetting('refresh_status_cloud')) {
        this.#stopRefreshTimer();

        this.log(`Refreshing from cloud every ${intervalMinutes} minute(s)`);

        this.refreshTimer = this.homey.setInterval(() => {
            this.refreshWeatherSiteStatus().catch((error) => {
                this.error('Scheduled refresh failed:', error);
            });
        }, 60_000 * intervalMinutes);
    }

    #stopRefreshTimer() {
        if (this.refreshTimer) {
            this.homey.clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /**
     * Applies a changed refresh interval immediately, so users no longer have
     * to restart the app for it to take effect.
     *
     * @param {object} event
     * @param {object} event.newSettings
     * @param {string[]} event.changedKeys
     */
    async onSettings({ newSettings, changedKeys }) {
        if (changedKeys.includes('refresh_status_cloud')) {
            this.#startRefreshTimer(newSettings.refresh_status_cloud);
        }
    }

    /**
     * @param {string} key Capability id.
     * @param {string|number} value
     */
    async _updateProperty(key, value) {
        if (!this.hasCapability(key)) {
            return;
        }

        // The station has no sensor for this reading; leave the last known
        // value in place rather than inventing one.
        if (value === undefined || value === null) {
            return;
        }

        const oldValue = this.getCapabilityValue(key);

        try {
            await this.setCapabilityValue(key, value);
        } catch (error) {
            this.error(`Failed to update capability '${key}':`, error);
            return;
        }

        if (key === 'measure_rain.snow' && oldValue !== null && oldValue !== value) {
            await this.driver.triggerSnowChanged(this, { snow: value });
        }
    }

    async onDeleted() {
        this.log(`Deleting Trafikverket weather station '${this.getName()}' from Homey.`);
        await this.onUninit();
    }

    async onUninit() {
        this.#stopRefreshTimer();
        this.api?.removeAllListeners();
        this.api = null;
        this.weatherImages?.clear();
    }

}

module.exports = WeatherDevice;
module.exports.degreesToCompassPoint = degreesToCompassPoint;
