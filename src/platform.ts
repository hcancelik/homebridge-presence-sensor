import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PresenceSensorAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import express from 'express';

export class PresenceSensorPlatformPlugin implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PresenceSensorAccessory> = new Map();
  private server: express.Express;

  // Track timers for each accessory
  private silenceTimers: Map<string, NodeJS.Timeout> = new Map();
  private noMotionTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const port = this.config.port || 9988;
    this.server = express();
    this.server.use(express.json());

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();

      this.server.post('/motion', (req, res) => {
        const { deviceId, data } = req.body;
        this.log.debug(`Received motion event from ${deviceId}:`, data);
        this.handleMotionEvent(deviceId, data);
        res.sendStatus(200);
      });

      this.server.listen(port, '0.0.0.0', () => {
        this.log.info(`HTTP server listening on port ${port}`);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    const existingAccessory = new PresenceSensorAccessory(this, accessory);
    this.accessories.set(accessory.UUID, existingAccessory);
  }

  discoverDevices() {
    const devices = [
      { uniqueId: 'ESP32-LD2410', displayName: 'Presence Sensor' },
    ];

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.uniqueId);
      if (this.accessories.has(uuid)) {
        this.log.info(`Accessory ${device.displayName} already registered.`);
        continue;
      }

      this.log.info(`Registering new accessory: ${device.displayName}`);
      const accessory = new this.api.platformAccessory(device.displayName, uuid);
      accessory.context.device = device;

      const newAccessory = new PresenceSensorAccessory(this, accessory);
      this.accessories.set(uuid, newAccessory);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  handleMotionEvent(deviceId: string, data: Record<string, number>) {
    const uuid = this.api.hap.uuid.generate(deviceId);
    const accessory = this.accessories.get(uuid);

    if (!accessory) {
      this.log.warn(`No accessory found for deviceId: ${deviceId}`);
      return;
    }

    const maxStationaryDistance = this.config.maxStationaryDistance || 150;
    const minStationarySignal = this.config.minStationarySignal || 15;
    const maxMovingDistance = this.config.maxMovingDistance || 150;
    const minMovingSignal = this.config.minMovingSignal || 15;

    const isMotionDetected =
      (
        Number(data.stationaryDistance) > 0 &&
        Number(data.stationaryDistance) < maxStationaryDistance &&
        Number(data.stationarySignal) > minStationarySignal
      ) ||
      (
        Number(data.movingDistance) > 0 &&
        Number(data.movingDistance) < maxMovingDistance &&
        Number(data.movingSignal) > minMovingSignal
      );

    if (isMotionDetected) {
      // 1) Cancel any scheduled "no motion" debounce
      const pendingNoMotion = this.noMotionTimers.get(uuid);
      if (pendingNoMotion) {
        clearTimeout(pendingNoMotion);
        this.noMotionTimers.delete(uuid);
      }

      // 2) Set motion to true immediately if not already
      accessory.updateMotionDetected(true);

      // 3) Cancel any existing "silence" timer and start a new one
      //    so if the sensor goes silent, we turn motion off after motionOffDelay.
      const existingSilenceTimer = this.silenceTimers.get(uuid);
      if (existingSilenceTimer) {
        clearTimeout(existingSilenceTimer);
      }
      const motionOffDelay = (Number(this.config.motionOffDelay) || 10) * 1000;
      const silenceTimer = setTimeout(() => {
        this.log.debug(`No further data for ${deviceId}, setting motion false...`);
        accessory.updateMotionDetected(false);
        this.silenceTimers.delete(uuid);
      }, motionOffDelay);

      this.silenceTimers.set(uuid, silenceTimer);

    } else {
      // No motion event received
      // 1) Clear the "silence" timer because sensor is explicitly telling us no motion
      const existingSilenceTimer = this.silenceTimers.get(uuid);
      if (existingSilenceTimer) {
        clearTimeout(existingSilenceTimer);
        this.silenceTimers.delete(uuid);
      }

      // 2) Debounce "no motion" to avoid false flips if the sensor toggles quickly
      const noMotionDelay = (Number(this.config.noMotionDelay) || 5) * 1000;

      // Clear any existing noMotion timer first
      const existingNoMotionTimer = this.noMotionTimers.get(uuid);
      if (existingNoMotionTimer) {
        clearTimeout(existingNoMotionTimer);
      }

      // 3) Schedule "no motion" in the future
      const noMotionTimer = setTimeout(() => {
        this.log.debug(`Confirmed no motion for ${deviceId}, setting motion false...`);
        accessory.updateMotionDetected(false);
        this.noMotionTimers.delete(uuid);
      }, noMotionDelay);

      this.noMotionTimers.set(uuid, noMotionTimer);
    }
  }
}
