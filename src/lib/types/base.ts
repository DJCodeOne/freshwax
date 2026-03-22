// src/lib/types/base.ts
// Base types shared across all type modules

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}

export interface Ratings {
  average: number;
  count: number;
  total: number;
}
