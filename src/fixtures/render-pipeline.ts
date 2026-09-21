// User-facing architecture example loaded by the demo menu. Service names
// are labels; the fixture contains no provider SVG artwork.

import type { DiagramState } from '@/store/types';

/** A faithful YAML-shaped render-pipeline diagram, mid-promotion.
 *  - Cognito at fidelity 0.55 demonstrates per-shape override
 *  - SQS / Redis on the Notes layer with low-fidelity treatment
 *  - Two sticky notes (always sketch regardless of fidelity)
 *  Keep all of these - they cover every fidelity edge case in one fixture. */
export function renderPipeline(): DiagramState {
  return {
    version: '1.0',
    meta: {
      title: 'render-pipeline',
      defaults: { fidelity: 1 },
    },
    shapes: [
      { id: 'vpc', kind: 'group', x: 80, y: 110, w: 720, h: 380, label: 'VPC eu-west-1', layer: 'blueprint', fidelity: 1, seed: 1 },
      { id: 'cf', kind: 'service', x: 130, y: 200, w: 130, h: 64, label: 'CloudFront', icon: 'CF', layer: 'blueprint', fidelity: 1, seed: 4,
        meta: { 'aws.region': 'global', 'terraform.id': 'aws_cloudfront.main' } },
      { id: 'apigw', kind: 'service', x: 320, y: 200, w: 130, h: 64, label: 'API Gateway', sublabel: '/v2/*', icon: 'API', layer: 'blueprint', fidelity: 1, seed: 5,
        meta: { 'aws.region': 'eu-west-1', 'auth': 'cognito' } },
      { id: 'lambda', kind: 'service', x: 510, y: 200, w: 130, h: 64, label: 'render-worker', sublabel: 'λ • node20', icon: 'λ', layer: 'blueprint', fidelity: 1, seed: 6,
        meta: { 'aws.region': 'eu-west-1', 'memory': '1024MB', 'timeout': '30s', 'terraform.id': 'aws_lambda.render' } },
      { id: 'rds', kind: 'service', x: 510, y: 360, w: 130, h: 64, label: 'blueprintr-db', sublabel: 'pg 15.4', icon: 'RDS', layer: 'blueprint', fidelity: 1, seed: 7,
        meta: { 'aws.region': 'eu-west-1', 'engine': 'postgres' } },
      { id: 's3', kind: 'service', x: 320, y: 360, w: 130, h: 64, label: 'asset-bucket', icon: 'S3', layer: 'blueprint', fidelity: 1, seed: 8,
        meta: { 'aws.region': 'eu-west-1' } },
      { id: 'queue', kind: 'rect', x: 700, y: 200, w: 120, h: 64, label: 'SQS?', layer: 'notes', fidelity: 0.1, seed: 11 },
      { id: 'cache', kind: 'ellipse', x: 700, y: 360, w: 120, h: 64, label: 'Redis cache?', layer: 'notes', fidelity: 0.15, seed: 12 },
      { id: 'note', kind: 'note', x: 870, y: 200, w: 180, h: 110, label: 'do we need a queue\nbefore the worker for\nlong renders?', layer: 'notes', fidelity: 0, seed: 13 },
      { id: 'cdn-note', kind: 'note', x: 80, y: 540, w: 220, h: 70, label: 'CF in front of S3 too?\n- need to confirm w/ Bea', layer: 'notes', fidelity: 0, seed: 14 },
      { id: 'auth', kind: 'rect', x: 130, y: 360, w: 130, h: 64, label: 'Cognito', layer: 'blueprint', fidelity: 0.55, seed: 15,
        meta: { 'aws.region': 'eu-west-1' } },
    ],
    connectors: [
      { id: 'c1', from: { shape: 'cf', anchor: 'right' }, to: { shape: 'apigw', anchor: 'left' }, routing: 'straight', label: 'HTTPS', style: 'solid', meta: { 'latency.p99': '12ms' } },
      { id: 'c2', from: { shape: 'apigw', anchor: 'right' }, to: { shape: 'lambda', anchor: 'left' }, routing: 'straight', label: 'invoke', style: 'solid', meta: { 'terraform.id': 'aws_apigw_integration.render', 'latency.p99': '180ms' } },
      { id: 'c3', from: { shape: 'lambda', anchor: 'bottom' }, to: { shape: 'rds', anchor: 'top' }, routing: 'orthogonal', label: 'pg', style: 'solid' },
      { id: 'c4', from: { shape: 'lambda', anchor: 'auto' }, to: { shape: 's3', anchor: 'auto' }, routing: 'curved', label: 'PUT', style: 'solid' },
      { id: 'c5', from: { shape: 'apigw', anchor: 'bottom' }, to: { shape: 'auth', anchor: 'top' }, routing: 'orthogonal', label: 'verify', style: 'dashed' },
      { id: 'c6', from: { shape: 'apigw', anchor: 'auto' }, to: { shape: 'queue', anchor: 'auto' }, routing: 'curved', label: 'maybe?', style: 'dashed' },
      { id: 'c7', from: { shape: 'lambda', anchor: 'right' }, to: { shape: 'cache', anchor: 'left' }, routing: 'straight', label: 'read-thru', style: 'dashed' },
    ],
    annotations: [],
  };
}
