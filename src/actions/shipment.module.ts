import { Module, OnModuleInit } from '@nestjs/common';
import { ActionRegistry } from '../bulk-engine/action-registry';
import { AdapterRegistry } from '../bulk-engine/adapter-registry';
import { FxModule } from '../fx/fx.module';
import { ApplyChargeAction } from './apply-charge.action';
import { ShipmentAdapter } from './shipment.adapter';
import { TransitionStatusAction } from './transition-status.action';

/**
 * The Shipment plugin. Adding an entity (e.g. Invoice) = a module like this one with its
 * own adapter + actions. Adding an action = a class + one register() line below.
 */
@Module({
  imports: [FxModule],
  providers: [ShipmentAdapter, ApplyChargeAction, TransitionStatusAction],
})
export class ShipmentModule implements OnModuleInit {
  constructor(
    private readonly adapters: AdapterRegistry,
    private readonly actions: ActionRegistry,
    private readonly shipmentAdapter: ShipmentAdapter,
    private readonly applyCharge: ApplyChargeAction,
    private readonly transitionStatus: TransitionStatusAction,
  ) {}

  onModuleInit(): void {
    this.adapters.register(this.shipmentAdapter);
    this.actions.register(this.applyCharge);
    this.actions.register(this.transitionStatus);
  }
}
