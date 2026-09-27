import { BadRequestException, Controller, Get, Headers, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-only helper (not in the spec) so a demo can show the effect of a job on a shipment:
 * its current status and every applied charge line.
 */
@ApiTags('shipments')
@Controller('v1/shipments')
export class ShipmentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':shipmentNo')
  @ApiOperation({ summary: 'One shipment with its status and every applied charge line (demo helper)' })
  @ApiQuery({ name: 'tenant_id', required: false, example: 'tnt_demo' })
  @ApiHeader({ name: 'X-Tenant-Id', required: false })
  async get(
    @Param('shipmentNo') shipmentNo: string,
    @Query('tenant_id') tenantQuery?: string,
    @Headers('x-tenant-id') tenantHeader?: string,
  ) {
    const tenantId = tenantHeader || tenantQuery;
    if (!tenantId) {
      throw new BadRequestException('tenant_id query param or X-Tenant-Id header is required');
    }
    const s = await this.prisma.shipment.findUnique({
      where: { tenantId_shipmentNo: { tenantId, shipmentNo } },
      include: { charges: { orderBy: { id: 'asc' } } },
    });
    if (!s) {
      throw new NotFoundException(`Shipment ${shipmentNo} not found`);
    }
    return {
      id: s.id,
      tenant_id: s.tenantId,
      shipment_no: s.shipmentNo,
      trade_type: s.tradeType,
      origin_port: s.originPort,
      destination_port: s.destinationPort,
      container_count: s.containerCount,
      chargeable_weight: s.chargeableWeight,
      customer_id: s.customerId,
      status: s.status,
      billing_currency: s.billingCurrency,
      is_billed: s.isBilled,
      charges: s.charges.map((c) => ({
        charge_code: c.chargeCode,
        basis: c.basis,
        rate: c.rate,
        currency: c.currency,
        amount: c.amount,
        fx_rate: c.fxRate,
        amount_billing: c.amountBilling,
        billing_currency: c.billingCurrency,
        bulk_job_id: c.bulkJobId,
        created_at: c.createdAt,
      })),
    };
  }
}
