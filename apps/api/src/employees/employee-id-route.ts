/**
 * Route segment for "an employee id" under `/employees/...`: only a real UUID counts.
 *
 * A bare `:id` takes ANY single path segment, so `GET /employees/:id` also answered `GET /employees/contacts`,
 * `/employees/addresses`, `/employees/education` and every other literal sub-resource that another controller owns
 * (the employee screens' contact, address, family, education, asset and payment lists all got 400 "malformed id" on the
 * live site). Because the controllers are matched in the order they are registered, the fix is not to rely on order:
 * an id here has to look like an id, so a word like "contacts" falls through to the controller that owns it.
 */
export const EMPLOYEE_ID = ":id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
