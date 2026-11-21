import { PointerSensor } from '@dnd-kit/core';

/**
 * dnd-kit's pointer sensor, for a mouse or a pen only. A finger is left to the TouchSensor, so a touch drag starts
 * with its long press; otherwise this sensor would take the touch's pointer events first and start after 5 px.
 */
export class MouseAndPenSensor extends PointerSensor {
  static override activators = PointerSensor.activators.map((activator) => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      args[0].nativeEvent.pointerType !== 'touch' && activator.handler(...args),
  }));
}
