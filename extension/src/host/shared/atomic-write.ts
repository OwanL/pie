// Compatibility re-export. The implementation is shared by the extension host
// and backend so both processes use identical atomic-replace semantics.
export * from '../../shared/atomic-write';
