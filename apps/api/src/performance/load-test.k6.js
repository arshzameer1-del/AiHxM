/**
 * Phase 14: Load Testing Script for BoostFactor API
 *
 * Tests concurrent user load (100 users) across all core endpoints
 * Measures response times, error rates, and throughput
 *
 * Run with: k6 run load-test.k6.js
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend, Counter, Gauge } from "k6/metrics";

// Custom metrics
const errorRate = new Rate("errors");
const loginDuration = new Trend("login_duration");
const employeeListDuration = new Trend("employee_list_duration");
const leaveRequestDuration = new Trend("leave_request_duration");
const payrollCalculationDuration = new Trend("payroll_calculation_duration");
const performanceReviewDuration = new Trend("performance_review_duration");
const concurrentUsers = new Gauge("concurrent_users");
const totalRequests = new Counter("total_requests");

// Test configuration
export const options = {
  stages: [
    // Ramp-up: gradually increase to 100 users over 1 minute
    { duration: "1m", target: 100 },
    // Stay at 100 users for 5 minutes
    { duration: "5m", target: 100 },
    // Ramp-down: gradually decrease to 0 users over 1 minute
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    // 95% of requests must complete below 2 seconds
    "employee_list_duration": ["p(95)<2000"],
    "login_duration": ["p(95)<1000"],
    "leave_request_duration": ["p(95)<1500"],
    "payroll_calculation_duration": ["p(95)<3000"],
    // Error rate must be below 1%
    "errors": ["rate<0.01"],
  },
};

const BASE_URL = "http://localhost:3000";

// Test user pool
const testUsers = [
  { email: "hr-admin-1@example.com", password: "AdminPassword123!" },
  { email: "hr-admin-2@example.com", password: "AdminPassword123!" },
  { email: "manager-1@example.com", password: "ManagerPassword123!" },
  { email: "manager-2@example.com", password: "ManagerPassword123!" },
  { email: "employee-1@example.com", password: "EmployeePassword123!" },
];

let authTokens = [];

export function setup() {
  /**
   * Setup: Authenticate test users and prepare data
   */
  console.log("Setup: Authenticating test users...");

  for (const user of testUsers) {
    const response = http.post(`${BASE_URL}/auth/login`, {
      email: user.email,
      password: user.password,
    });

    check(response, {
      "login status is 200": (r) => r.status === 200,
    });

    if (response.status === 200) {
      authTokens.push({
        token: response.json().token,
        userEmail: user.email,
      });
    }
  }

  console.log(`Setup complete: ${authTokens.length} users authenticated`);
  return { authTokens };
}

export default function (data) {
  /**
   * Main test: Simulate realistic user workload
   */
  concurrentUsers.add(__VU); // Track concurrent users
  const userAuth = data.authTokens[__VU % data.authTokens.length];
  const token = userAuth.token;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Group 1: Authentication & Profile
  group("Authentication & Profile", () => {
    const response = http.get(`${BASE_URL}/auth/me`, { headers });
    loginDuration.add(response.timings.duration);
    totalRequests.add(1);

    check(response, {
      "auth/me status is 200": (r) => r.status === 200,
      "response time < 500ms": (r) => r.timings.duration < 500,
    });

    if (response.status !== 200) {
      errorRate.add(1);
    }
  });

  sleep(1);

  // Group 2: Employee Management (List & Detail)
  group("Employee Management", () => {
    // List employees
    const listResponse = http.get(`${BASE_URL}/employees`, { headers });
    employeeListDuration.add(listResponse.timings.duration);
    totalRequests.add(1);

    check(listResponse, {
      "employee list status is 200": (r) => r.status === 200,
      "response time < 1500ms": (r) => r.timings.duration < 1500,
    });

    if (listResponse.status !== 200) {
      errorRate.add(1);
    }

    // Get employee detail
    if (listResponse.status === 200) {
      const employees = listResponse.json().data || [];
      if (employees.length > 0) {
        const employeeId = employees[0].id;
        const detailResponse = http.get(`${BASE_URL}/employees/${employeeId}`, {
          headers,
        });
        totalRequests.add(1);

        check(detailResponse, {
          "employee detail status is 200": (r) => r.status === 200,
        });

        if (detailResponse.status !== 200) {
          errorRate.add(1);
        }
      }
    }
  });

  sleep(1);

  // Group 3: Leave Management
  group("Leave Management", () => {
    // Get leave balance
    const balanceResponse = http.get(`${BASE_URL}/leave/balance`, { headers });
    totalRequests.add(1);

    check(balanceResponse, {
      "leave balance status is 200 or 404": (r) =>
        r.status === 200 || r.status === 404,
    });

    // Get leave requests
    const requestsResponse = http.get(`${BASE_URL}/leave/requests`, { headers });
    leaveRequestDuration.add(requestsResponse.timings.duration);
    totalRequests.add(1);

    check(requestsResponse, {
      "leave requests status is 200": (r) => r.status === 200,
      "response time < 1500ms": (r) => r.timings.duration < 1500,
    });

    if (requestsResponse.status !== 200) {
      errorRate.add(1);
    }

    // Get leave policies
    const policiesResponse = http.get(`${BASE_URL}/leave/policies`, { headers });
    totalRequests.add(1);

    check(policiesResponse, {
      "leave policies status is 200": (r) => r.status === 200,
    });
  });

  sleep(1);

  // Group 4: Payroll Operations (Read-heavy)
  group("Payroll Operations", () => {
    const response = http.get(`${BASE_URL}/payroll/slips`, { headers });
    payrollCalculationDuration.add(response.timings.duration);
    totalRequests.add(1);

    check(response, {
      "payroll slips status is 200": (r) => r.status === 200,
      "response time < 2000ms": (r) => r.timings.duration < 2000,
    });

    if (response.status !== 200) {
      errorRate.add(1);
    }
  });

  sleep(1);

  // Group 5: Performance & Goals
  group("Performance & Goals", () => {
    const response = http.get(`${BASE_URL}/performance/reviews`, { headers });
    performanceReviewDuration.add(response.timings.duration);
    totalRequests.add(1);

    check(response, {
      "performance reviews status is 200": (r) => r.status === 200,
      "response time < 1500ms": (r) => r.timings.duration < 1500,
    });

    if (response.status !== 200) {
      errorRate.add(1);
    }
  });

  sleep(2);
}

export function teardown(data) {
  /**
   * Teardown: Log summary statistics
   */
  console.log("Load test completed");
  console.log(`Total requests: ${totalRequests.value}`);
}
