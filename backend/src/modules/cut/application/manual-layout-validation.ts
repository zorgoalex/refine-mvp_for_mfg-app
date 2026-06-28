/**
 * Thin re-export of the shared pure geometry/validation module.
 * Both backend and frontend import from @shared/cut-geometry; this re-export
 * keeps existing relative path references (./manual-layout-validation) working
 * inside the backend module tree.
 */
export * from '../../../../../shared/cut-geometry';
