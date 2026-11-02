import { attributionRepository } from "@eval/workflows/attribution";
import { comparisonRepository } from "@eval/workflows/comparison";
import { businessResultRepository } from "@eval/workflows/review";

export const businessAttributionRepository = businessResultRepository(attributionRepository);
export const businessComparisonRepository = businessResultRepository(comparisonRepository);
