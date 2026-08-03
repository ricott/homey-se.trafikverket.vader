'use strict';

const Homey = require('homey');

class TrafikverketWeatherApp extends Homey.App {

    async onInit() {
        this.log('Trafikverket weather has been initialized');
    }

}

module.exports = TrafikverketWeatherApp;
