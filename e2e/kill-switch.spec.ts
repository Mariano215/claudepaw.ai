import { test, expect } from '@playwright/test'

test.describe('kill switch (admin)', () => {
  test('admin can trip and clear the switch', async ({ page }) => {
    await page.goto(`${process.env.DASHBOARD_BASE_URL}/#settings`)
    await page.getByRole('button', { name: 'Pause all agents (kill switch)' }).click()
    // Fill in the inline modal
    await page.getByLabel('Reason').fill('cost spike investigation')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByText(/tripped/i)).toBeVisible()
    await page.getByRole('button', { name: 'Clear kill switch' }).click()
    await expect(page.getByText(/no kill switch active/i)).toBeVisible()
  })

  test('member cannot see the button', async ({ page, context }) => {
    await context.addCookies([{ name: 'dashboard_api_token', value: process.env.MEMBER_TOKEN!, domain: '127.0.0.1', path: '/' }])
    await page.goto(`${process.env.DASHBOARD_BASE_URL}/#settings`)
    await expect(page.getByRole('button', { name: 'Pause all agents (kill switch)' })).toHaveCount(0)
  })
})
