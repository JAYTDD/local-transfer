import type { Repository } from './db.js';

export interface ModelList {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

export function listPublicModels(repository: Repository): ModelList['data'] {
  return repository.listPublicModels().map((model) => ({
    id: model.id,
    object: 'model',
    created: model.createdAt,
    owned_by: 'aihub',
  }));
}
