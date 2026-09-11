const CALIBRATION_SCHEMA_VERSION = 1;

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${label} is required`);
  return {
    label,
    treeBytes: requireNonNegativeInteger(snapshot.treeBytes, `${label}.treeBytes`),
    mainDatabaseBytes: requireNonNegativeInteger(snapshot.mainDatabaseBytes, `${label}.mainDatabaseBytes`),
    mainFileBytes: requireNonNegativeInteger(snapshot.mainFileBytes, `${label}.mainFileBytes`),
  };
}

export function validateCapacitySnapshotInventory(snapshot, { mainDatabaseFile, expectedLabel }) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') return { valid: false, errors: ['capacity snapshot is missing'] };
  if (typeof mainDatabaseFile !== 'string' || mainDatabaseFile.length === 0 || mainDatabaseFile.includes('/')) {
    return { valid: false, errors: ['mainDatabaseFile must be a root-relative file name'] };
  }
  if (!Array.isArray(snapshot.files)) return { valid: false, errors: ['capacity snapshot file inventory is missing'] };
  if (expectedLabel !== undefined && snapshot.label !== expectedLabel) {
    errors.push(`capacity snapshot label must be ${expectedLabel}`);
  }
  const seen = new Set();
  let treeBytes = 0;
  let mainDatabaseBytes = 0;
  let mainFileBytes = 0;
  for (const [index, entry] of snapshot.files.entries()) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`capacity snapshot file[${index}] is invalid`);
      continue;
    }
    const relativePath = entry.path;
    const pathSegments = typeof relativePath === 'string' ? relativePath.split('/') : [];
    if (typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath.includes('\\')
      || relativePath.includes('//')
      || relativePath.includes(':')
      || relativePath.includes('\0')
      || relativePath.startsWith('/')
      || relativePath.startsWith('./')
      || relativePath.endsWith('/')
      || pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      errors.push(`capacity snapshot file[${index}] path is not a normalized relative path`);
      continue;
    }
    const identityPath = relativePath.toLowerCase();
    if (seen.has(identityPath)) errors.push(`capacity snapshot file path is duplicated: ${relativePath}`);
    seen.add(identityPath);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      errors.push(`capacity snapshot file ${relativePath} bytes are invalid`);
      continue;
    }
    treeBytes += entry.bytes;
    if (relativePath === mainDatabaseFile
      || relativePath === `${mainDatabaseFile}-wal`
      || relativePath === `${mainDatabaseFile}-shm`) {
      mainDatabaseBytes += entry.bytes;
    }
    if (relativePath === mainDatabaseFile) mainFileBytes = entry.bytes;
    if (!Number.isSafeInteger(treeBytes) || !Number.isSafeInteger(mainDatabaseBytes)) {
      errors.push('capacity snapshot inventory byte totals exceed safe integer range');
      break;
    }
  }
  if (treeBytes !== snapshot.treeBytes) errors.push('capacity snapshot tree bytes do not match its file inventory');
  if (mainDatabaseBytes !== snapshot.mainDatabaseBytes) errors.push('capacity snapshot main database-family bytes do not match its file inventory');
  if (mainFileBytes !== snapshot.mainFileBytes) errors.push('capacity snapshot main file bytes do not match its file inventory');
  return { valid: errors.length === 0, errors, reason: errors.length > 0 ? errors.join('; ') : undefined };
}

export function buildCapacityCalibration({
  baselineRows,
  detailRows,
  snapshots,
  observedTreeBytes = [],
  prewriteProjectedTreeBytes = [],
}) {
  const rows = requirePositiveInteger(baselineRows, 'baselineRows');
  const details = requirePositiveInteger(detailRows, 'detailRows');
  if (!snapshots || typeof snapshots !== 'object') throw new Error('snapshots are required');

  const beforePrimaryFacts = requireSnapshot(snapshots.beforePrimaryFacts, 'before-primary-facts');
  const afterPrimaryFacts = requireSnapshot(snapshots.afterPrimaryFacts, 'after-primary-facts');
  const afterVariableDetails = requireSnapshot(snapshots.afterVariableDetails, 'after-variable-details');
  const finalBeforeCorruption = requireSnapshot(snapshots.finalBeforeCorruption, 'final-before-corruption');
  const afterCorruptionCopy = requireSnapshot(snapshots.afterCorruptionCopy, 'after-corruption-copy');
  const observedTrees = observedTreeBytes.map((value, index) => (
    requireNonNegativeInteger(value, `observedTreeBytes[${index}]`)
  ));
  const projectedPrewrites = prewriteProjectedTreeBytes.map((value, index) => (
    requireNonNegativeInteger(value, `prewriteProjectedTreeBytes[${index}]`)
  ));

  const primaryFactBytes = afterPrimaryFacts.mainDatabaseBytes - beforePrimaryFacts.mainDatabaseBytes;
  const variableDetailBytes = afterVariableDetails.mainDatabaseBytes - afterPrimaryFacts.mainDatabaseBytes;
  const preCopyHighWaterBytes = Math.max(
    beforePrimaryFacts.treeBytes,
    afterPrimaryFacts.treeBytes,
    afterVariableDetails.treeBytes,
    finalBeforeCorruption.treeBytes,
    ...observedTrees,
  );
  const fixedTreeBytes = preCopyHighWaterBytes - primaryFactBytes - variableDetailBytes;
  const corruptionCopyBytes = afterCorruptionCopy.treeBytes - finalBeforeCorruption.treeBytes;
  const observedHighWaterBytes = Math.max(
    preCopyHighWaterBytes,
    afterCorruptionCopy.treeBytes,
  );
  const prewriteHighWaterBytes = Math.max(0, ...projectedPrewrites);
  const conservativeHighWaterBytes = Math.max(observedHighWaterBytes, prewriteHighWaterBytes);
  const errors = [];
  const orderedSnapshots = [beforePrimaryFacts, afterPrimaryFacts, afterVariableDetails, finalBeforeCorruption, afterCorruptionCopy];
  if (details * 10 !== rows) errors.push('detailRows must equal one tenth of baselineRows');
  if (observedTrees.length === 0) errors.push('observed proof-tree measurements are missing');
  if (projectedPrewrites.length === 0) errors.push('prewrite proof-tree projections are missing');
  for (const snapshot of orderedSnapshots) {
    if (snapshot.mainDatabaseBytes > snapshot.treeBytes) errors.push(`${snapshot.label} main database-family exceeds its proof tree`);
    if (snapshot.mainFileBytes > snapshot.mainDatabaseBytes) errors.push(`${snapshot.label} main file exceeds its database family`);
  }
  for (let index = 1; index < orderedSnapshots.length; index++) {
    if (orderedSnapshots[index].treeBytes < orderedSnapshots[index - 1].treeBytes) {
      errors.push(`${orderedSnapshots[index].label} tree bytes moved backwards`);
    }
  }
  if (primaryFactBytes <= 0) errors.push('primary fact database-family increment was not positive');
  if (variableDetailBytes <= 0) errors.push('variable detail database-family increment was not positive');
  if (finalBeforeCorruption.mainDatabaseBytes < afterVariableDetails.mainDatabaseBytes) {
    errors.push('final main database-family bytes moved backwards after variable detail capture');
  }
  if (afterCorruptionCopy.mainDatabaseBytes !== finalBeforeCorruption.mainDatabaseBytes) {
    errors.push('canonical main database-family bytes changed during the corruption copy');
  }
  if (fixedTreeBytes < 0) errors.push('fixed tree bytes would require offsetting a variable component');
  if (finalBeforeCorruption.mainFileBytes <= 0) errors.push('final main database file was not measured');
  if (corruptionCopyBytes !== finalBeforeCorruption.mainFileBytes) {
    errors.push('corruption copy snapshot does not contain exactly one full main database file copy');
  }

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    units: 'bytes',
    baselineRows: rows,
    detailRows: details,
    snapshots: {
      beforePrimaryFacts,
      afterPrimaryFacts,
      afterVariableDetails,
      finalBeforeCorruption,
      afterCorruptionCopy,
    },
    observedTreeBytes: observedTrees,
    components: {
      primaryFactBytes,
      variableDetailBytes,
      fixedTreeBytes,
      finalMainDatabaseBytes: finalBeforeCorruption.mainDatabaseBytes,
      finalMainFileBytes: finalBeforeCorruption.mainFileBytes,
      corruptionCopyBytes,
      preCopyHighWaterBytes,
    },
    prewriteProjectedTreeBytes: projectedPrewrites,
    observedHighWaterBytes,
    prewriteHighWaterBytes,
    conservativeHighWaterBytes,
    eligible: errors.length === 0,
    errors,
  };
}

export function validateCapacityCalibration(calibration, { baselineRows, detailRows }) {
  const errors = [];
  if (!calibration || typeof calibration !== 'object') {
    const missing = ['capacity calibration is missing'];
    return { valid: false, errors: missing, reason: missing.join('; ') };
  }
  if (calibration.schemaVersion !== CALIBRATION_SCHEMA_VERSION) errors.push('capacity calibration schema version is unsupported');
  if (calibration.units !== 'bytes') errors.push('capacity calibration units must be bytes');
  if (calibration.baselineRows !== baselineRows) errors.push('capacity calibration baseline row count does not match');
  if (calibration.detailRows !== detailRows) errors.push('capacity calibration detail row count does not match');

  try {
    const rebuilt = buildCapacityCalibration({
      baselineRows,
      detailRows,
      snapshots: calibration.snapshots,
      observedTreeBytes: calibration.observedTreeBytes,
      prewriteProjectedTreeBytes: calibration.prewriteProjectedTreeBytes,
    });
    if (!rebuilt.eligible) errors.push(...rebuilt.errors);
    for (const [name, value] of Object.entries(rebuilt.components)) {
      if (calibration.components?.[name] !== value) errors.push(`capacity calibration component ${name} is inconsistent`);
    }
    if (calibration.observedHighWaterBytes !== rebuilt.observedHighWaterBytes) {
      errors.push('capacity calibration observed high-water value is inconsistent');
    }
    if (calibration.prewriteHighWaterBytes !== rebuilt.prewriteHighWaterBytes) {
      errors.push('capacity calibration prewrite high-water value is inconsistent');
    }
    if (calibration.conservativeHighWaterBytes !== rebuilt.conservativeHighWaterBytes) {
      errors.push('capacity calibration conservative high-water value is inconsistent');
    }
    if (calibration.eligible !== rebuilt.eligible) errors.push('capacity calibration eligibility is inconsistent');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, errors, reason: errors.length > 0 ? errors.join('; ') : undefined };
}

export function projectCapacityFromCalibration(calibration, { targetRows, safetyFactor }) {
  const rows = requirePositiveInteger(targetRows, 'targetRows');
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) throw new Error('safetyFactor must be a finite number >= 1');
  const validation = validateCapacityCalibration(calibration, {
    baselineRows: calibration?.baselineRows,
    detailRows: calibration?.detailRows,
  });
  if (!validation.valid) throw new Error(`capacity calibration is invalid: ${validation.errors.join('; ')}`);
  if (rows < calibration.baselineRows || rows % calibration.baselineRows !== 0) {
    throw new Error('targetRows must be an integer multiple of baselineRows and cannot be smaller');
  }

  const rowRatio = rows / calibration.baselineRows;
  const primaryFactBytes = Math.ceil(calibration.components.primaryFactBytes * rowRatio * safetyFactor);
  const variableDetailBytes = Math.ceil(calibration.components.variableDetailBytes * rowRatio * safetyFactor);
  const projectedSteadyTreeBytes = calibration.components.fixedTreeBytes + primaryFactBytes + variableDetailBytes;
  const projectedMainDatabaseCopyBytes = Math.ceil(
    calibration.components.finalMainDatabaseBytes * rowRatio * safetyFactor,
  );
  const projectedFaultPeakBytes = projectedSteadyTreeBytes + projectedMainDatabaseCopyBytes;
  return {
    units: 'bytes',
    targetRows: rows,
    rowRatio,
    safetyFactor,
    components: {
      fixedTreeBytes: calibration.components.fixedTreeBytes,
      primaryFactBytes,
      variableDetailBytes,
      projectedMainDatabaseCopyBytes,
    },
    projectedSteadyTreeBytes,
    projectedFaultPeakBytes,
    projectedPeakBytes: Math.max(
      calibration.conservativeHighWaterBytes,
      projectedSteadyTreeBytes,
      projectedFaultPeakBytes,
    ),
  };
}
