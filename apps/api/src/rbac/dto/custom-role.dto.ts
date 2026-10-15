import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateCustomRoleDto {
  @IsString() @MaxLength(50) key!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) permissionKeys?: string[];
}

export class SetRolePermissionsDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) permissionKeys!: string[];
}
