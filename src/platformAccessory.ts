import { Service, PlatformAccessory } from 'homebridge';
import { PresenceSensorPlatformPlugin } from './platform';

export class PresenceSensorAccessory {
  private motionService: Service;

  constructor(
    private readonly platform: PresenceSensorPlatformPlugin,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = this.platform;

    this.motionService = this.accessory.getServiceById(Service.MotionSensor, 'motion-sensor') ||
      this.accessory.addService(Service.MotionSensor, accessory.displayName, 'motion-sensor');

    this.motionService
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => {
        this.platform.log.debug('Getting motion detected state');

        return false; // Default to false
      });
  }

  updateMotionDetected(state: boolean) {
    this.motionService
      .getCharacteristic(this.platform.Characteristic.MotionDetected)
      .updateValue(state);
    this.platform.log.info(
      `MotionDetected updated for ${this.accessory.displayName}: ${state}`,
    );
  }
}
