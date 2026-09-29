// Shared, pure helpers for the v2 graph editor. Reference features never enter the editable collection.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const sharedLocation = () => ({ buildingNodeId: null, floor: '0', floorOrder: 0 });
  const locationKey = (value) => value ? `${value.buildingNodeId ?? ''}:${value.floor ?? ''}` : '';
  const locationLabel = (value) => !value || value.buildingNodeId == null ? '공용 경로 · 층 없음'
    : `${value.buildingName || value.buildingCode || `건물 #${value.buildingNodeId}`} ${value.floor}층`;
  const locations = (layer) => layer?.kind === 'SHARED_PATHS' ? [sharedLocation()]
    : layer?.locations?.length ? layer.locations
    : layer?.buildingNodeId ? [{ buildingNodeId: layer.buildingNodeId, buildingCode: layer.buildingCode,
      buildingName: layer.buildingName, floor: layer.floor, floorOrder: layer.floorOrder }] : [];
  const locationValue = (value) => value ? { buildingNodeId: value.buildingNodeId ?? null,
    floor: value.floor == null ? '0' : String(value.floor), floorOrder: value.floorOrder ?? 0 } : null;

  function withDefaults(collection, location, shared) {
    return { ...collection, features: collection.features.map((feature) => {
      const p = { ...(feature.properties || {}) };
      const persistedNode = p.overlayable?.nodeId != null;
      const persistedEdges = Array.isArray(p.overlayable?.segmentEdgeIds) && p.overlayable.segmentEdgeIds.length > 0;
      if (feature.geometry?.type === 'Point' && !p.location && location && !persistedNode) p.location = locationValue(location);
      if (feature.geometry?.type === 'LineString') {
        // The line default is used only for vertices without a node reference.
        if (!p.location && location) p.location = locationValue(location);
        if (p.indoor == null) p.indoor = !shared;
        if (p.bidirectional == null) p.bidirectional = true;
        if (!p.edgeType) p.edgeType = shared ? 'OUTDOOR_PATH' : 'CORRIDOR';
        if (!p.weightMode && !persistedEdges) p.weightMode = 'AUTO';
      }
      return { ...feature, properties: p };
    }) };
  }

  function vertexRefs(feature) {
    const count = feature.geometry.coordinates.length;
    const meta = feature.properties?.overlayable || {};
    return Array.from({ length: count }, (_, i) => meta.vertexRefs?.[i]
      || (meta.vertexNodeIds?.[i] ? { editorId: meta.vertexNodeIds[i] } : null));
  }

  function bindEndpoint(feature, end, reference, ownerLayerId = null) {
    if (feature?.geometry?.type !== 'LineString') throw new Error('선 하나를 선택하세요.');
    const coordinates = feature.geometry.coordinates.map((c) => [...c]);
    const index = end === 'start' ? 0 : coordinates.length - 1;
    const refs = vertexRefs(feature);
    const oldMeta = feature.properties?.overlayable || {};
    if (reference) {
      const meta = reference.properties?.overlayable;
      if (!meta?.nodeId || !meta?.ownerLayerId) throw new Error('저장된 참조 노드를 선택하세요.');
      refs[index] = meta.ownerLayerId === ownerLayerId
        ? { editorId: meta.editorId || reference.id }
        : { nodeId: meta.nodeId, ownerLayerId: meta.ownerLayerId };
      coordinates[index] = [...reference.geometry.coordinates];
    } else {
      // A detached endpoint becomes a new local node; never reuse a foreign editor ID.
      refs[index] = null;
    }
    const meta = { ...oldMeta, vertexRefs: refs };
    delete meta.vertexNodeIds;
    return { ...feature, geometry: { ...feature.geometry, coordinates },
      properties: { ...feature.properties, overlayable: meta } };
  }

  function referenceCollection(snapshots, automatic = [], automaticRevisions = {}) {
    const points = new Map();
    const lines = [];
    const revisions = new Map();
    for (const snapshot of snapshots) for (const feature of snapshot.geojson?.features || []) {
      if (feature.geometry?.type === 'LineString') {
        lines.push({ ...feature, id: `edge-ref-${snapshot.layerId}-${feature.id}`, properties: { ...feature.properties,
          overlayable: { ...feature.properties?.overlayable, kind: 'edge-reference', ownerLayerId: snapshot.layerId } } });
        continue;
      }
      const nodeId = feature.properties?.overlayable?.nodeId;
      if (feature.geometry?.type !== 'Point' || !nodeId) continue;
      revisions.set(nodeId, snapshot.revision || 0);
      points.set(nodeId, { ...feature, id: `node-ref-${nodeId}`, properties: { ...feature.properties,
        overlayable: { ...feature.properties.overlayable, kind: 'node-reference', ownerLayerId: snapshot.layerId } } });
    }
    for (const feature of automatic) {
      if (feature.geometry?.type !== 'Point') continue;
      const meta = feature.properties?.overlayable || {};
      if (!points.has(meta.nodeId) || (automaticRevisions[meta.ownerLayerId] || 0) >= revisions.get(meta.nodeId)) points.set(meta.nodeId, feature);
    }
    return { type: 'FeatureCollection', features: [...lines, ...points.values()] };
  }

  function validateExternalVertices(collection, references) {
    const points = new Map((references || []).filter((feature) => feature.geometry?.type === 'Point')
      .map((feature) => [feature.properties?.overlayable?.nodeId, feature.geometry.coordinates]));
    for (const feature of collection.features) {
      if (feature.geometry?.type !== 'LineString') continue;
      for (const [index, ref] of (feature.properties?.overlayable?.vertexRefs || []).entries()) {
        const expected = ref?.nodeId && points.get(ref.nodeId);
        const actual = feature.geometry.coordinates[index];
        if (!expected || !actual) continue; // Unknown references are validated by the backend.
        const radians = Math.PI / 180;
        const dlat = (actual[1] - expected[1]) * radians;
        const dlng = (actual[0] - expected[0]) * radians;
        const a = Math.sin(dlat / 2) ** 2 + Math.cos(actual[1] * radians) * Math.cos(expected[1] * radians) * Math.sin(dlng / 2) ** 2;
        if (6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) > 0.02) {
          throw new Error(`외부 연결점 Node #${ref.nodeId}은 여기서 이동할 수 없습니다. 참조 노드에 다시 연결하거나 연결을 해제하세요.`);
        }
      }
    }
  }

  NS.workspace = { sharedLocation, locationKey, locationLabel, locations, locationValue,
    withDefaults, vertexRefs, bindEndpoint, referenceCollection, validateExternalVertices };
})();
