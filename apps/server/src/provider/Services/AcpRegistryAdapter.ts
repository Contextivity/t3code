/**
 * AcpRegistryAdapter — shape type for the generic ACP Registry provider adapter.
 *
 * The driver model ({@link ../Drivers/AcpRegistryDriver}) bundles one adapter
 * per instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module AcpRegistryAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AcpRegistryAdapterShape — per-instance ACP Registry adapter contract.
 */
export interface AcpRegistryAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
