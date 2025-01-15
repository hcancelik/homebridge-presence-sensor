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
import { connect } from 'mqtt';

export class PresenceSensorPlatformPlugin implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PresenceSensorAccessory> = new Map();

  // Tracks how many consecutive "no motion" signals we've received
  private noMotionCounts: Map<string, number> = new Map();
  private presenceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const mqttHost = this.config.mqttHost || 'mqtt://192.168.68.55';
    const mqttTopic = this.config.mqttTopic || 'bedroom_sensor/data';
    const mqttClient = connect(mqttHost);

    this.api.on('didFinishLaunching', () => {
      mqttClient.on('connect', () => {
        this.log.info('MQTT connected');

        mqttClient.subscribe(mqttTopic, (err) => {
          if (err) {
            this.log.error('MQTT subscribe error:', err);
          } else {
            this.log.info(`Subscribed to topic ${mqttTopic}`);
          }
        });
      });

      mqttClient.on('message', (topic, message) => {
        try {
          const payload = JSON.parse(message.toString());
          const { deviceId, data } = payload;

          this.log.debug(`MQTT message from ${deviceId}:`, data);

          this.handleMotionEvent(deviceId, data);
        } catch (err) {
          this.log.error('Failed to parse MQTT message:', err);
        }
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
      accessory.updateMotionDetected(true);

      if (this.presenceTimers.has(uuid)) {
        clearTimeout(this.presenceTimers.get(uuid)!);
      }

      this.presenceTimers.set(uuid, setTimeout(() => {
        this.log.debug(`Motion timed out for ${deviceId}, turning off`);
        accessory.updateMotionDetected(false);
      }, (this.config.turnOffTimeout || 3) * 1000));
    }
  }
}
