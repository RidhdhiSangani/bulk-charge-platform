import { Injectable } from '@nestjs/common';
import { EntityAdapter } from './entity-adapter';

@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<string, EntityAdapter>();

  register(adapter: EntityAdapter): void {
    this.adapters.set(adapter.entityType, adapter);
  }

  get(entityType: string): EntityAdapter {
    const adapter = this.find(entityType);
    if (!adapter) {
      throw new Error(`No entity adapter registered for ${entityType}`);
    }
    return adapter;
  }

  find(entityType: string): EntityAdapter | undefined {
    return this.adapters.get(entityType);
  }
}
