/** Single delivery or all received turn deliveries; the last index also locates final generation. */
export const finalIndices = (material: { final_message_index: number; final_message_indices?: number[] }) =>
  material.final_message_indices ?? [material.final_message_index];
