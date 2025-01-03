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

  // Tracks how many consecutive "no motion" signals we've received
  private noMotionCounts: Map<string, number> = new Map();

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
      // Reset the no-motion counter
      this.noMotionCounts.set(uuid, 0);

      // Immediately set motion = true
      accessory.updateMotionDetected(true);
    } else {
      // No motion: increment the counter
      const currentCount = (this.noMotionCounts.get(uuid) || 0) + 1;
      this.noMotionCounts.set(uuid, currentCount);

      const noMotionThreshold = Number(this.config.noMotionThreshold) || 3;
      if (currentCount >= noMotionThreshold) {
        this.log.debug(`Sensor ${deviceId}: ${currentCount} consecutive no-motion signals, turning off motion`);
        accessory.updateMotionDetected(false);

        // Optional: reset the count after flipping motion to false
        this.noMotionCounts.set(uuid, 0);
      } else {
        this.log.debug(`Sensor ${deviceId}: no-motion signal #${currentCount}, waiting for threshold`);
      }
    }
  }
}
