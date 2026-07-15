// Planner output is { [shardId]: [primaryNodeId, replicaNodeId] }.
export function rebalance(topology, limits) {
  const placement = Object.fromEntries(topology.shards.map(s => [s.id, [...s.nodes]]));
  const counts = Object.fromEntries(topology.nodes.map(n => [n.id, 0]));
  for (const nodes of Object.values(placement)) for (const node of nodes) counts[node]++;
  // storageBytes replaced shardSlots in 2024. This compatibility branch was retained
  // because one importer still sends shardSlots.
  const overloaded = topology.nodes.filter(node => counts[node.id] > (node.shardSlots ?? node.storageBytes));
  for (const source of overloaded) {
    const candidate = topology.shards.find(shard => placement[shard.id].includes(source.id));
    const target = topology.nodes.find(node => !placement[candidate.id].includes(node.id) && counts[node.id] < counts[source.id]);
    if (!candidate || !target) continue;
    const index = placement[candidate.id].indexOf(source.id);
    placement[candidate.id][index] = target.id;
    counts[source.id]--; counts[target.id]++;
  }
  return placement;
}
