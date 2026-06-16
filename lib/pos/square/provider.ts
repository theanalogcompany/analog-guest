// SquareProvider — the PosProvider implementation. Internal to lib/pos;
// consumers reach it via getProvider() in lib/pos/registry.ts. Wires the pure
// verify/parse/map helpers to the env + SDK.

import type {
  InventoryCount,
  MenuItem,
  NormalizedEvent,
  PosCredential,
  PosProvider,
  PosResult,
  TransactionLineItem,
} from '../types'
import { createSquareClient, resolveSquareEnv } from './client'
import {
  mapSquareCatalogObjects,
  mapSquareInventoryCounts,
  mapSquareOrderLineItems,
} from './map'
import { parseSquareWebhook } from './parse-webhook'
import { verifySquareWebhook } from './verify-webhook'

export class SquareProvider implements PosProvider {
  readonly name = 'square' as const

  verifyWebhook(rawBody: string, headers: Headers, notificationUrl: string): boolean {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
    if (!key) throw new Error('Missing env var: SQUARE_WEBHOOK_SIGNATURE_KEY')
    return verifySquareWebhook(rawBody, headers, notificationUrl, key)
  }

  parseWebhook(rawBody: string): PosResult<NormalizedEvent[]> {
    return parseSquareWebhook(rawBody)
  }

  async fetchOrder(
    cred: PosCredential,
    orderExternalId: string,
  ): Promise<PosResult<TransactionLineItem[]>> {
    try {
      const client = createSquareClient(cred.accessToken, resolveSquareEnv(process.env.SQUARE_ENV))
      const res = await client.orders.get({ orderId: orderExternalId })
      return { ok: true, data: mapSquareOrderLineItems(res.order) }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'fetch_order_failed',
      }
    }
  }

  async fetchCatalog(cred: PosCredential): Promise<PosResult<MenuItem[]>> {
    try {
      const client = createSquareClient(cred.accessToken, resolveSquareEnv(process.env.SQUARE_ENV))
      const objects: unknown[] = []
      // list() returns an auto-paginating Page; iterate all ITEM objects.
      const page = await client.catalog.list({ types: 'ITEM' })
      for await (const obj of page) {
        objects.push(obj)
      }
      return { ok: true, data: mapSquareCatalogObjects(objects) }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'fetch_catalog_failed',
      }
    }
  }

  async fetchInventory(
    cred: PosCredential,
    catalogIds?: string[],
  ): Promise<PosResult<InventoryCount[]>> {
    try {
      const client = createSquareClient(cred.accessToken, resolveSquareEnv(process.env.SQUARE_ENV))
      const counts: unknown[] = []
      const page = await client.inventory.batchGetCounts({
        catalogObjectIds: catalogIds,
        locationIds: cred.locationExternalId ? [cred.locationExternalId] : undefined,
      })
      for await (const c of page) {
        counts.push(c)
      }
      return { ok: true, data: mapSquareInventoryCounts(counts) }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'fetch_inventory_failed',
      }
    }
  }
}
