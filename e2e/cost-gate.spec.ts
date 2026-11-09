import { test, expect } from '@playwright/test'

test('Project Settings - cost cap inputs render and persist', async ({ page }) => {
  await page.goto(`${process.env.DASHBOARD_BASE_URL}/#settings?project=default`)
  await page.getByLabel('Monthly cost cap ($)').fill('150')
  await page.getByLabel('Daily cost cap ($)').fill('10')
  await page.getByRole('button', { name: 'Save caps' }).click()
  await expect(page.getByText('Caps saved')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Monthly cost cap ($)')).toHaveValue('150')
})
