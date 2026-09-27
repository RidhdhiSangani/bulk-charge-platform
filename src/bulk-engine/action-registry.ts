import { Injectable } from '@nestjs/common';
import { BulkAction } from './bulk-action';

@Injectable()
export class ActionRegistry {
  private readonly actions = new Map<string, BulkAction>();

  register(action: BulkAction): void {
    this.actions.set(this.key(action.entityType, action.actionType), action);
  }

  get(entityType: string, actionType: string): BulkAction {
    const action = this.find(entityType, actionType);
    if (!action) {
      throw new Error(`No bulk action registered for ${entityType}:${actionType}`);
    }
    return action;
  }

  find(entityType: string, actionType: string): BulkAction | undefined {
    return this.actions.get(this.key(entityType, actionType));
  }

  list(): { entity_type: string; action_type: string }[] {
    return [...this.actions.values()].map((a) => ({
      entity_type: a.entityType,
      action_type: a.actionType,
    }));
  }

  private key(entityType: string, actionType: string): string {
    return `${entityType}:${actionType}`;
  }
}
