import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { PresenceSensorAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import express from 'express';

export class PresenceSensorPlatformPlugin implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PresenceSensorAccessory> = new Map();

  private server: express.Express;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Start HTTP server to listen for events from ESP32
    const port = this.config.port || 9988;
    this.server = express();
    this.server.use(express.json());

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();

      this.server.post('/motion', (req, res) => {
        const { deviceId, motionDetected } = req.body;

        this.log.info(`Received motion event from ${deviceId}:`, motionDetected);

        this.handleMotionEvent(deviceId, motionDetected);

        res.sendStatus(200);
      });

      this.server.listen(port, '0.0.0.0',  () => {
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

  handleMotionEvent(deviceId: string, motionDetected: boolean) {
    const uuid = this.api.hap.uuid.generate(deviceId);
    const accessory = this.accessories.get(uuid);

    if (!accessory) {
      this.log.warn(`No accessory found for deviceId: ${deviceId}`);
      return;
    }

    accessory.updateMotionDetected(motionDetected);
  }
}
